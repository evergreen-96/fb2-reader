import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  Notice,
  Modal,
  MarkdownPostProcessorContext,
  MarkdownPostProcessor,
} from "obsidian";

/**
 * Настройки плагина
 */
interface FB2ReaderPluginSettings {
  imageFolderPath: string;

  /**
   * Словарь: ключ — полный путь MD-файла,
   * значение — пиксельная прокрутка или процент (на ваше усмотрение).
   * В примере будем хранить пиксели "scrollTop".
   */
  readingProgress: Record<string, number>;
}

const DEFAULT_SETTINGS: FB2ReaderPluginSettings = {
  imageFolderPath: "fb2-images",
  readingProgress: {},
};

/**
 * Данные о секции (главе) для FB2-конвертации
 */
interface SectionData {
  title: string;
  paragraphs: Element[];
  level: number;
  children: SectionData[];
}

export default class FB2ReaderPlugin extends Plugin {
  settings!: FB2ReaderPluginSettings;

  /**
   * "Глобальная" ссылка на текущий элемент-прогрессбар (если нужно явно удалять/обновлять),
   * но в примере ниже будем создавать его заново для каждой рендеренной заметки.
   */
  private currentProgressBar: HTMLDivElement | null = null;

  async onload() {
    await this.loadSettings();

    // 1) Команда: выбрать FB2 и сконвертировать в MD
    this.addCommand({
      id: "choose-fb2-file",
      name: "Convert FB2 to MD (choose file)",
      checkCallback: (checking) => {
        if (!checking) {
          new ChooseFB2FileModal(this.app, (file) => {
            this.convertFB2(file);
          }).open();
        }
        return true;
      },
    });

    // 2) Регистрируем Markdown Post Processor
    //    Он будет вызываться, когда Obsidian отрендерит любую MD-заметку в Preview.
    const postProcessor: MarkdownPostProcessor = (el, ctx) => {
      // el: это корневой DOM-элемент контента
      // ctx: есть поле sourcePath, где лежит путь к файлу
      this.enhanceReadingProgress(el, ctx);
    };
    this.registerMarkdownPostProcessor(postProcessor);

    // 3) Настройки плагина
    this.addSettingTab(new FB2ReaderSettingTab(this.app, this));
  }

  /**
   * Основной метод конвертации FB2 → MD (пример из предыдущих сообщений).
   */
  async convertFB2(file: TFile) {
    if (!file) {
      new Notice("No file selected!");
      return;
    }

    console.log(`Selected FB2 File: ${file.path}`);
    const xmlContent = await this.app.vault.read(file);

    // Парсим как XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, "text/xml");

    // Извлекаем бинарные данные (картинки)
    const binaryEls = Array.from(doc.querySelectorAll("binary"));
    const images = binaryEls.map((binary) => ({
      id: binary.getAttribute("id") || "",
      contentType: binary.getAttribute("content-type") || "image/jpeg",
      data: binary.textContent || "",
    }));
    const imageMap = new Map(images.map((img) => [img.id, img]));

    // Обложка
    const coverImgEl = doc.querySelector("description > title-info > coverpage > image");
    let coverMd = "";
    if (coverImgEl) {
      const coverHref = coverImgEl.getAttribute("l:href")?.replace(/^#/, "");
      if (coverHref) {
        const coverImg = imageMap.get(coverHref);
        if (coverImg && coverImg.data.trim()) {
          const coverPath = await this.saveImageToVault(file.basename, coverImg);
          coverMd = `## Обложка\n\n![[${coverPath}]]\n`;
        }
      }
    }

    // Секции
    const bodies = Array.from(doc.querySelectorAll("body"));
    if (bodies.length === 0) {
      new Notice("No <body> found in FB2.");
      return;
    }

    const allRootSections: SectionData[] = [];
    for (const bodyEl of bodies) {
      const topSections = Array.from(bodyEl.querySelectorAll(":scope > section"));
      for (const s of topSections) {
        allRootSections.push(this.parseSectionRecursive(s, 1));
      }
    }

    // Разворачиваем дерево секций
    const flatSections: SectionData[] = [];
    this.flattenSections(allRootSections, flatSections);

    // Формируем MD
    const mdLines: string[] = [];

    // Обложка
    if (coverMd) {
      mdLines.push(coverMd);
    }

    // Оглавление
    mdLines.push("# СОДЕРЖАНИЕ");
    for (const sec of flatSections) {
      const trimmedTitle = sec.title.trim();
      if (trimmedTitle) {
        mdLines.push(`- [[#${trimmedTitle}|${trimmedTitle}]]`);
      }
    }

    // Сами главы
    for (const sec of flatSections) {
      const headingLevel = Math.min(sec.level + 1, 6);
      const hashes = "#".repeat(headingLevel);

      const trimmedTitle = sec.title.trim();
      if (trimmedTitle) {
        mdLines.push(`\n${hashes} ${trimmedTitle}`);
      } else {
        mdLines.push("\n");
      }

      for (const node of sec.paragraphs) {
        if (node.tagName.toLowerCase() === "image") {
          const href = node.getAttribute("l:href")?.replace(/^#/, "");
          if (!href) continue;

          const imgData = imageMap.get(href);
          if (!imgData || !imgData.data.trim()) continue;

          const imagePath = await this.saveImageToVault(file.basename, imgData);
          mdLines.push(`![[${imagePath}]]`);
        } else if (node.tagName.toLowerCase() === "p") {
          mdLines.push(this.processFB2Paragraph(node));
        } else {
          mdLines.push(node.textContent?.trim() || "");
        }
      }
    }

    const newMdPath = `${file.basename}.md`;
    const finalText = mdLines.join("\n\n");
    await this.app.vault.create(newMdPath, finalText);

    this.app.workspace.openLinkText(newMdPath, "", false);
    new Notice(`FB2 converted: ${newMdPath}`);
  }

  /**
   * Добавляет прогресс-бар в элемент preview и восстанавливает прокрутку,
   * если мы действительно в режиме preview и есть возможность прокручивать.
   */
  private enhanceReadingProgress(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    // 1) Определим контейнер прокрутки. Обычно .markdown-preview-view — родительский элемент el.
    //    Но в Obsidian может быть вложенность; пойдём вверх, пока не найдём класс .markdown-preview-view
    let container = el.closest(".markdown-preview-view") as HTMLElement | null;
    if (!container) return; // не нашли, значит ничего не делаем

    // 2) Создадим прогресс-бар (добавим его в начало preview)
    //    В данном примере делаем это один раз, проверяя, нет ли уже нашего progressBar.
    //    Идентифицировать можем по какому-то классу.
    const existingBar = container.querySelector(".fb2-reading-progress-bar") as HTMLDivElement;
    if (existingBar) {
      // Уже был добавлен — значит повторно не вставляем, а просто используем его
      this.currentProgressBar = existingBar;
    } else {
      // Создаём контейнер-обёртку
      const barWrap = createDiv({ cls: "fb2-reading-progress-wrap" });
      barWrap.setAttr("style", "position:relative; width:100%; height:8px; background:#ccc; margin-bottom:8px;");

      // Создаём саму полосу
      const bar = createDiv({ cls: "fb2-reading-progress-bar" });
      bar.setAttr("style", "position:absolute; left:0; top:0; height:8px; width:0; background:#007FFF;");
      barWrap.appendChild(bar);

      // Вставляем в контейнер (в начало)
      // Обычно container.firstChild - это .markdown-preview-sizer, но лучше prepend()
      container.prepend(barWrap);

      this.currentProgressBar = bar;
    }

    // 3) Подключаем обработчик скролла, чтобы вычислять прогресс
    //    В Obsidian preview скролл может происходить на самом container (или его внутренностях).
    //    Чаще всего scrollTop/scrollHeight относятся к .markdown-preview-view, но нужно проверять.
    //    Пусть будет container.
    //    Чтобы не дублировать события, может быть имеет смысл сначала удалить старый слушатель, если он есть.
    //    Для простоты – просто регистрируем (Obsidian сам пересобирает DOM постфактум).
    this.registerDomEvent(container, "scroll", () => {
      this.updateScrollProgress(container, ctx.sourcePath);
    });

    // 4) Восстанавливаем предыдущую прокрутку (если есть) — делаем это после 0ms, чтобы DOM отрисовался
    window.setTimeout(() => {
      const lastScroll = this.settings.readingProgress[ctx.sourcePath] ?? 0;
      if (lastScroll > 0) {
        container.scrollTo({ top: lastScroll, behavior: "instant" as ScrollBehavior });
        // И заодно выставим ширину полосы
        this.updateProgressBar(container, ctx.sourcePath);
      }
    }, 0);
  }

  /**
   * При скролле сохраняем текущий scrollTop в настройках
   * и обновляем ширину полосы прогресса
   */
  private updateScrollProgress(container: HTMLElement, filePath: string) {
    // сохраняем scrollTop
    const st = container.scrollTop;
    this.settings.readingProgress[filePath] = st;
    // обновляем полосу
    this.updateProgressBar(container, filePath);
  }

  /**
   * Ширина = (scrollTop / (scrollHeight - clientHeight)) * 100%
   */
  private updateProgressBar(container: HTMLElement, filePath: string) {
    if (!this.currentProgressBar) return;
    const st = container.scrollTop;
    const maxScroll = container.scrollHeight - container.clientHeight;
    let ratio = 1;
    if (maxScroll > 0) {
      ratio = st / maxScroll;
    }
    this.currentProgressBar.style.width = (ratio * 100).toFixed(2) + "%";
  }

  /**
   * Рекурсивный парсинг <section> (FB2)
   */
  parseSectionRecursive(sectionEl: Element, level: number): SectionData {
    let titleText = "";
    const titleEl = sectionEl.querySelector(":scope > title");
    if (titleEl) {
      const pInTitle = titleEl.querySelector("p");
      if (pInTitle && pInTitle.textContent?.trim()) {
        titleText = pInTitle.textContent.trim();
      } else if (titleEl.textContent?.trim()) {
        titleText = titleEl.textContent.trim();
      }
    }

    const paragraphs = Array.from(sectionEl.querySelectorAll(":scope > p, :scope > image"));
    const childSecEls = Array.from(sectionEl.querySelectorAll(":scope > section"));
    const childSections: SectionData[] = childSecEls.map((el) =>
      this.parseSectionRecursive(el, level + 1)
    );

    return {
      title: titleText,
      paragraphs,
      level,
      children: childSections,
    };
  }

  /**
   * Распаковать дерево секций в плоский список
   */
  flattenSections(sections: SectionData[], result: SectionData[]) {
    for (const sec of sections) {
      result.push(sec);
      if (sec.children.length) {
        this.flattenSections(sec.children, result);
      }
    }
  }

  /**
   * Сохранение base64-картинки
   */
  async saveImageToVault(
    bookName: string,
    image: { id: string; contentType: string; data: string }
  ): Promise<string> {
    const folderPath = `${this.settings.imageFolderPath}/${bookName}`;
    const extension = image.contentType.split("/")[1] || "jpg";
    const fileName = `${image.id}.${extension}`;

    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    const filePath = `${folderPath}/${fileName}`;
    const binaryData = atob(image.data.trim());
    const arrayBuffer = new Uint8Array(binaryData.length);
    for (let i = 0; i < binaryData.length; i++) {
      arrayBuffer[i] = binaryData.charCodeAt(i);
    }

    try {
      await this.app.vault.createBinary(filePath, arrayBuffer);
    } catch (err) {
      console.warn(`Error creating or file exists: ${filePath}`, err);
    }

    return filePath;
  }

  /**
   * Преобразование <p> с учётом форматирования (простое)
   */
  processFB2Paragraph(pEl: Element): string {
    let md = "";
    for (const child of Array.from(pEl.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        md += child.nodeValue?.replace(/\s+/g, " ") || "";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        const innerText = el.textContent?.trim() || "";
        switch (tag) {
          case "strong":
          case "b":
            md += `**${innerText}**`;
            break;
          case "emphasis":
          case "i":
            md += `*${innerText}*`;
            break;
          default:
            md += innerText;
            break;
        }
      }
    }
    return md.trim();
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/**
 * Модальное окно, где пользователь выбирает .fb2-файл
 */
class ChooseFB2FileModal extends Modal {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Select FB2 file to convert" });

    const fb2Files = this.app.vault.getFiles().filter((f) => f.extension === "fb2");
    if (fb2Files.length === 0) {
      contentEl.createEl("p", { text: "No .fb2 files found in the Vault." });
      return;
    }

    fb2Files.forEach((file) => {
      const btn = contentEl.createEl("button", { text: file.name });
      btn.addEventListener("click", () => {
        this.close();
        this.onChoose(file);
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Настройки плагина
 */
class FB2ReaderSettingTab extends PluginSettingTab {
  plugin: FB2ReaderPlugin;

  constructor(app: App, plugin: FB2ReaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "FB2 Reader Plugin Settings" });

    new Setting(containerEl)
      .setName("Image Folder Path")
      .setDesc("Specify the folder path for saving images from .fb2 files.")
      .addText((text) =>
        text
          .setPlaceholder("fb2-images")
          .setValue(this.plugin.settings.imageFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.imageFolderPath = value || "fb2-images";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Reading Progress" });
    containerEl.createEl("p", {
      text: "Automatically tracks scroll position in preview. Uses file path as key.",
    });
  }
}
