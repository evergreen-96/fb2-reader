import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	Notice,
	Modal,
	MarkdownView,
} from "obsidian";

/* ============================== */
/* ======= Типы и Интерфейсы ===== */
/* ============================== */

/**
 * Настройки плагина для конвертации FB2.
 */
interface FB2ReaderPluginSettings {
	imageFolderPath: string;
	outputFolderPath: string;
}

/**
 * Интерфейс для хранения позиций чтения.
 * Ключ – путь к файлу, значение – положение прокрутки (в пикселях).
 */
interface LastReadPositions {
	[filePath: string]: number;
}

const DEFAULT_SETTINGS: FB2ReaderPluginSettings = {
	imageFolderPath: "fb2-images",
	outputFolderPath: "",
};

/**
 * Данные о секции (главе) и её вложенных секциях.
 */
interface SectionData {
	title: string;
	paragraphs: Element[];
	epigraphs: Element[];
	level: number;
	children: SectionData[];
}

/**
 * Карта сносок: id → содержимое.
 */
type FootnotesMap = Map<string, string>;

/**
 * Метаданные книги.
 */
interface BookMetaInfo {
	title: string;
	authors: string[];
	coverHref: string;
}

/**
 * Интерфейс объединённых данных для сохранения во внешнем хранилище.
 */
interface PluginData {
	imageFolderPath: string;
	outputFolderPath: string;
	lastReadPositions: LastReadPositions;
}

/* ============================== */
/* ======= Основной Плагин ====== */
/* ============================== */

export default class FB2ReaderPlugin extends Plugin {
	settings!: FB2ReaderPluginSettings;
	// Карта сносок, заполняется при конвертации FB2.
	private footnotes: FootnotesMap = new Map();
	// Объект для хранения позиций чтения по файлам.
	private lastReadPositions: LastReadPositions = {};

	async onload() {
		await this.loadSettings();
    
		// Регистрируем событие изменения активного листа.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				try {
					this.handleActiveLeafChange(leaf);
				} catch (error) {
					console.error("Error in active-leaf-change handler:", error);
				}
			})
		);

		this.addCommand({
			id: "choose-fb2-file",
			name: "Convert FB2 to MD (choose file)",
			checkCallback: (checking: boolean) => {
				if (!checking) {
					new ChooseFB2FileModal(this.app, (file) => {
						this.convertFB2(file);
					}).open();
				}
				return true;
			},
		});

		this.addSettingTab(new FB2ReaderSettingTab(this.app, this));
	}

	/**
	 * Если открыта Markdown-заметка, пытаемся восстановить сохранённое положение прокрутки.
	 */
	private handleActiveLeafChange(leaf: any) {
		if (!leaf) return;
		const view = leaf.view;
		if (view instanceof MarkdownView && view.contentEl) {
			const file = view.file;
			if (!file) return;
			const savedScroll = this.lastReadPositions[file.path];
			if (savedScroll !== undefined) {
				// Немного задержки, чтобы контент точно загрузился.
				window.setTimeout(() => {
					try {
						view.contentEl.scrollTop = savedScroll;
					} catch (e) {
						console.error("Error setting scrollTop:", e);
					}
				}, 100);
			}
			// Если обработчик скролла ещё не добавлен, добавляем его.
			if (!view.contentEl.getAttribute("data-scroll-listener")) {
				view.contentEl.setAttribute("data-scroll-listener", "true");
				view.contentEl.addEventListener("scroll", () => {
					try {
						this.lastReadPositions[file.path] = view.contentEl.scrollTop;
						this.savePluginData();
					} catch (e) {
						console.error("Error in scroll event handler:", e);
					}
				});
			}
		}
	}

	/**
	 * Основной метод конвертации FB2 → Markdown.
	 */
	async convertFB2(file: TFile) {
		if (!file) {
			new Notice("No file selected!");
			return;
		}

		const xmlContent = await this.app.vault.read(file);
		const parser = new DOMParser();
		let doc: Document;
		try {
			doc = parser.parseFromString(xmlContent, "text/xml");
			if (doc.querySelector("parsererror")) {
				throw new Error("Invalid XML format");
			}
		} catch (error) {
			new Notice(`Error parsing FB2: ${error}`);
			return;
		}

		// 1. Парсинг метаданных (название, авторы, обложка)
		const meta = this.parseMetaInfo(doc);

		// 2. Парсинг сносок
		this.footnotes = this.parseFootnotes(doc);

		// 3. Извлечение изображений из тегов <binary>
		const imageMap = this.extractImages(doc);

		// 4. Выбор основного тела книги (body без type="notes")
		const mainBodies = Array.from(doc.querySelectorAll("body")).filter(
			(body) => body.getAttribute("type") !== "notes"
		);

		if (mainBodies.length === 0) {
			new Notice("No main <body> found in FB2.");
			return;
		}

		const allRootSections: SectionData[] = [];
		for (const bodyEl of mainBodies) {
			const topSections = Array.from(bodyEl.querySelectorAll(":scope > section"));
			topSections.forEach((sec) => {
				allRootSections.push(this.parseSectionRecursive(sec, 1));
			});
		}

		const flatSections: SectionData[] = [];
		this.flattenSections(allRootSections, flatSections);

		// 5. Формирование Markdown-документа
		const mdLines: string[] = [];
		this.addFrontMatter(mdLines, meta);
		await this.addCover(mdLines, meta, imageMap, file.basename);
		this.addTableOfContents(mdLines, flatSections);
		await this.addSections(mdLines, flatSections, imageMap, file.basename);

		// 6. Добавление сносок (если имеются)
		if (this.footnotes.size > 0) {
			mdLines.push("\n## Сноски\n");
			for (const [fnId, fnText] of this.footnotes.entries()) {
				mdLines.push(`[^${fnId}]: ${fnText}`);
			}
		}

		// 7. Сохранение Markdown-файла и его открытие
		const finalText = mdLines.join("\n\n");
		const outputFilePath = await this.getAvailableMdPath(file.basename);
		await this.app.vault.create(outputFilePath, finalText);
		this.app.workspace.openLinkText(outputFilePath, "", false);
		new Notice(`FB2 converted: ${outputFilePath}`);
	}

	/* ============================== */
	/* ========= Парсинг =========== */
	/* ============================== */

	private parseMetaInfo(doc: Document): BookMetaInfo {
		const titleInfo = doc.querySelector("description > title-info");
		let bookTitle = "";
		let authors: string[] = [];
		let coverHref = "";

		if (titleInfo) {
			bookTitle = titleInfo.querySelector("book-title")?.textContent?.trim() ?? "";
			authors = Array.from(titleInfo.querySelectorAll("author"))
				.map((authorEl) => {
					const first = authorEl.querySelector("first-name")?.textContent?.trim();
					const last = authorEl.querySelector("last-name")?.textContent?.trim();
					return [first, last].filter(Boolean).join(" ");
				})
				.filter(Boolean);
			coverHref =
				titleInfo.querySelector("coverpage > image[l\\:href]")?.getAttribute("l:href")?.replace(/^#/, "").toLowerCase() ?? "";
		}

		return { title: bookTitle, authors, coverHref };
	}

	private parseFootnotes(doc: Document): FootnotesMap {
		const footnotesMap: FootnotesMap = new Map();
		const notesBody = doc.querySelector('body[type="notes"]');
		if (!notesBody) return footnotesMap;

		const noteSections = Array.from(notesBody.querySelectorAll("section[id]"));
		noteSections.forEach((ns) => {
			const noteId = ns.getAttribute("id");
			if (!noteId) return;
			const text = Array.from(ns.querySelectorAll("p"))
				.map((p) => p.textContent?.trim() ?? "")
				.join(" ");
			footnotesMap.set(noteId, text);
		});
		return footnotesMap;
	}

	private parseSectionRecursive(sectionEl: Element, level: number): SectionData {
		const title =
			sectionEl.querySelector(":scope > title > p")?.textContent?.trim() ||
			sectionEl.querySelector(":scope > title")?.textContent?.trim() ||
			"";

		const epigraphs = Array.from(sectionEl.querySelectorAll(":scope > epigraph"));
		const paragraphs = Array.from(sectionEl.querySelectorAll(":scope > p, :scope > image"));
		const children = Array.from(sectionEl.querySelectorAll(":scope > section")).map((child) =>
			this.parseSectionRecursive(child, level + 1)
		);
		return { title, paragraphs, epigraphs, level, children };
	}

	private flattenSections(sections: SectionData[], result: SectionData[]) {
		sections.forEach((sec) => {
			result.push(sec);
			if (sec.children.length) this.flattenSections(sec.children, result);
		});
	}

	private extractImages(doc: Document): Map<string, { id: string; contentType: string; data: string }> {
		const binaries = Array.from(doc.querySelectorAll("binary")).map((binary) => ({
			id: (binary.getAttribute("id") ?? "").toLowerCase(),
			contentType: binary.getAttribute("content-type") ?? "image/jpeg",
			data: binary.textContent ?? "",
		}));
		return new Map(binaries.map((img) => [img.id, img]));
	}

	/* ============================== */
	/* ======= Формирование MD ====== */
	/* ============================== */

	private addFrontMatter(mdLines: string[], meta: BookMetaInfo) {
		mdLines.push("---");
		if (meta.title) {
			mdLines.push(`title: "${meta.title.replace(/"/g, '\\"')}"`);
		}
		if (meta.authors.length > 0) {
			mdLines.push(`authors: [${meta.authors.map((a) => `"${a}"`).join(", ")}]`);
		}
		mdLines.push("---\n");
	}

	private async addCover(
		mdLines: string[],
		meta: BookMetaInfo,
		imageMap: Map<string, { id: string; contentType: string; data: string }>,
		bookName: string
	) {
		if (!meta.coverHref) return;
		let coverData = imageMap.get(meta.coverHref);
		if (!coverData && meta.coverHref.includes(".")) {
			const altCoverId = meta.coverHref.split(".")[0];
			coverData = imageMap.get(altCoverId);
		}
		if (coverData) {
			const coverPath = await this.saveImageToVault(bookName, coverData);
			mdLines.push(`![[${coverPath}]]`);
		} else {
			console.log("Cover not found. coverHref:", meta.coverHref, "Available images:", Array.from(imageMap.keys()));
		}
	}

	private addTableOfContents(mdLines: string[], sections: SectionData[]) {
		mdLines.push("# СОДЕРЖАНИЕ");
		sections.forEach((sec) => {
			const title = sec.title.trim();
			if (title) mdLines.push(`- [[#${title}|${title}]]`);
		});
	}

	private async addSections(
		mdLines: string[],
		sections: SectionData[],
		imageMap: Map<string, { id: string; contentType: string; data: string }>,
		bookName: string
	) {
		for (const sec of sections) {
			const headingLevel = Math.min(sec.level + 1, 6);
			const title = sec.title.trim();
			mdLines.push(title ? `\n${"#".repeat(headingLevel)} ${title}` : "\n");

			// Эпиграфы
			for (const epigraphEl of sec.epigraphs) {
				const paragraphs = Array.from(epigraphEl.querySelectorAll("p"));
				mdLines.push(">"); // начало цитаты
				paragraphs.forEach((p) => {
					mdLines.push(`> ${this.processFB2Paragraph(p)}`);
				});
				mdLines.push(">"); // разделитель
			}

			// Параграфы и изображения
			for (const node of sec.paragraphs) {
				const tag = node.tagName.toLowerCase();
				if (tag === "image") {
					const href = node.getAttribute("l:href")?.replace(/^#/, "").toLowerCase();
					if (!href) continue;
					const imgData = imageMap.get(href);
					if (!imgData || !imgData.data.trim()) continue;
					const imagePath = await this.saveImageToVault(bookName, imgData);
					mdLines.push(`![[${imagePath}]]`);
				} else if (tag === "p") {
					mdLines.push(this.processFB2Paragraph(node));
				} else {
					mdLines.push(node.textContent?.trim() ?? "");
				}
			}
		}
	}

	/* ============================== */
	/* ========= Вспомогательное ==== */
	/* ============================== */

	private async saveImageToVault(
		bookName: string,
		image: { id: string; contentType: string; data: string }
	): Promise<string> {
		const folderPath = `${this.settings.imageFolderPath}/${bookName}`;
		await this.ensureFolderExists(folderPath);

		const extension = image.contentType.split("/")[1] ?? "jpg";
		let baseFileName = image.id.replace(/[^\w\d-_]/g, "_") || "image";
		let fileName = `${baseFileName}.${extension}`;
		let filePath = `${folderPath}/${fileName}`;

		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(filePath)) {
			fileName = `${baseFileName}_${counter}.${extension}`;
			filePath = `${folderPath}/${fileName}`;
			counter++;
		}

		const binaryData = this.base64ToUint8Array(image.data.trim());
		await this.app.vault.createBinary(filePath, binaryData);
		return filePath;
	}

	private async ensureFolderExists(path: string) {
		if (!this.app.vault.getAbstractFileByPath(path)) {
			await this.app.vault.createFolder(path);
		}
	}

	private base64ToUint8Array(base64: string): Uint8Array {
		const binaryString = atob(base64);
		const len = binaryString.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	private processFB2Paragraph(pEl: Element): string {
		let md = "";
		pEl.childNodes.forEach((child) => {
			if (child.nodeType === Node.TEXT_NODE) {
				md += (child.nodeValue || "").replace(/\s+/g, " ");
			} else if (child.nodeType === Node.ELEMENT_NODE) {
				const el = child as Element;
				const text = el.textContent?.trim() || "";
				switch (el.tagName.toLowerCase()) {
					case "strong":
					case "b":
						md += `**${text}**`;
						break;
					case "emphasis":
					case "i":
						md += `*${text}*`;
						break;
					case "u":
						md += `<u>${text}</u>`;
						break;
					case "strikethrough":
					case "s":
						md += `~~${text}~~`;
						break;
					case "sub":
						md += `<sub>${text}</sub>`;
						break;
					case "sup":
						md += `<sup>${text}</sup>`;
						break;
					case "a": {
						const href = el.getAttribute("xlink:href") ?? el.getAttribute("href");
						if (href?.startsWith("#")) {
							const footnoteId = href.slice(1);
							md += `[^${footnoteId}]`;
						} else if (href) {
							md += `[${text}](${href})`;
						} else {
							md += text;
						}
						break;
					}
					default:
						md += text;
						break;
				}
			}
		});
		return md.trim();
	}

	private async getAvailableMdPath(baseName: string): Promise<string> {
		const folder = this.settings.outputFolderPath.trim();
		if (folder) await this.ensureFolderExists(folder);

		let newMdPath = folder ? `${folder}/${baseName}.md` : `${baseName}.md`;
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(newMdPath)) {
			newMdPath = folder ? `${folder}/${baseName}_${counter}.md` : `${baseName}_${counter}.md`;
			counter++;
		}
		return newMdPath;
	}

	/* ============================== */
	/* ========= Загрузка и Сохранение данных ===== */
	/* ============================== */

	async loadSettings() {
		const data: PluginData | null = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.lastReadPositions = data?.lastReadPositions ?? {};
	}

	async saveSettings() {
		await this.saveData({
			...this.settings,
			lastReadPositions: this.lastReadPositions,
		});
	}

	private async savePluginData() {
		await this.saveData({
			...this.settings,
			lastReadPositions: this.lastReadPositions,
		});
	}
}

/* ============================== */
/* ========= UI-Модали ========= */
/* ============================== */

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

/* ============================== */
/* ==== Настройки Плагина ======= */
/* ============================== */

class FB2ReaderSettingTab extends PluginSettingTab {
	plugin: FB2ReaderPlugin;

	constructor(app: App, plugin: FB2ReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "FB2 Converter Settings" });

		new Setting(containerEl)
			.setName("Image Folder Path")
			.setDesc("Specify the folder path for saving images from .fb2 files. Example: books/imgs")
			.addText((text) =>
				text
					.setPlaceholder("fb2-images")
					.setValue(this.plugin.settings.imageFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.imageFolderPath = value.trim() || "fb2-images";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Output Folder Path")
			.setDesc("Specify the folder where the converted .md files will be stored. Example: books/output")
			.addText((text) =>
				text
					.setPlaceholder("output")
					.setValue(this.plugin.settings.outputFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.outputFolderPath = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}
