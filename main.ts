import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	Notice,
	Modal,
	MarkdownView,
	SuggestModal,
} from "obsidian";

/* ============================== */
/* ======= Types and Interfaces ====== */
/* ============================== */

interface FB2ReaderPluginSettings {
	imageFolderPath: string;
	outputFolderPath: string;
	quotesFolderPath: string;
	fb2BaseFolderPath: string;       // Base folder for searching FB2 files (relative to the Vault root)
	readingFontSize: string;         // e.g., "16px"
	readingFontColor: string;        // e.g., "#333"
	readingBackgroundColor: string;  // e.g., "#f5f5f5"
	readingLineHeight: string;       // e.g., "1.5"
	readingFontFamily: string;       // e.g., "sans-serif" or any custom value
	readingTextAlign: string;        // e.g., "left"
}

const DEFAULT_SETTINGS: FB2ReaderPluginSettings = {
	imageFolderPath: "fb2-images",
	outputFolderPath: "",
	quotesFolderPath: "quotes",
	fb2BaseFolderPath: "",
	readingFontSize: "16px",
	readingFontColor: "#333",
	readingBackgroundColor: "#f5f5f5",
	readingLineHeight: "1.5",
	readingFontFamily: "sans-serif",
	readingTextAlign: "left",
};

interface SectionData {
	title: string;
	paragraphs: Element[];
	epigraphs: Element[];
	level: number;
	children: SectionData[];
}

type FootnotesMap = Map<string, string>;

interface BookMetaInfo {
	title: string;
	authors: string[];
	coverHref: string;
}

interface PluginData {
	imageFolderPath: string;
	outputFolderPath: string;
	quotesFolderPath: string;
	// Removed lastReadPositions from stored data.
}

/* ============================== */
/* ======= Main Plugin Class ====== */
/* ============================== */

export default class FB2ReaderPlugin extends Plugin {
	settings!: FB2ReaderPluginSettings;
	private footnotes: FootnotesMap = new Map();
	// Removed lastReadPositions property.
	private isReadingMode: boolean = false;
	public readingStyleEl!: HTMLStyleElement;

	async onload() {
		await this.loadSettings();
		this.setupReadingModeStyle();

		// Removed automatic saving/restoring scroll functionality

		// Command: Choose FB2 file using SuggestModal.
		this.addCommand({
			id: "choose-fb2-file",
			name: "Convert FB2 to MD (choose file)",
			callback: () => {
				new FB2FileSuggestModal(this.app, this).open();
			},
		});

		// Command: Save Selected Text as Quote.
		this.addCommand({
			id: "save-selected-text-as-quote",
			name: "Save Selected Text as Quote",
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.editor) {
					if (checking) return true;
					this.handleSaveQuote(activeView);
				} else {
					new Notice("Open a Markdown file with text to quote.");
				}
				return true;
			},
		});

		// Command: Toggle Reading Mode.
		this.addCommand({
			id: "toggle-reading-mode",
			name: "Toggle Reading Mode",
			checkCallback: (checking: boolean) => {
				if (checking) return true;
				this.toggleReadingMode();
				return true;
			},
		});

		this.addSettingTab(new FB2ReaderSettingTab(this.app, this));
	}

	/**
	 * Initializes the reading mode style element.
	 */
	private setupReadingModeStyle() {
		const existing = document.getElementById("reading-mode-style");
		if (existing) {
			this.readingStyleEl = existing as HTMLStyleElement;
			return;
		}
		this.readingStyleEl = document.createElement("style");
		this.readingStyleEl.id = "reading-mode-style";
		this.updateReadingModeStyle();
		document.head.appendChild(this.readingStyleEl);
	}

	/**
	 * Updates the CSS rules for reading mode according to current settings.
	 */
	public updateReadingModeStyle() {
		this.readingStyleEl.innerText = `
			.markdown-preview-view.markdown-rendered.reading-mode {
				background: ${this.settings.readingBackgroundColor} !important;
				color: ${this.settings.readingFontColor} !important;
				font-size: ${this.settings.readingFontSize} !important;
				line-height: ${this.settings.readingLineHeight} !important;
				font-family: ${this.settings.readingFontFamily} !important;
				text-align: ${this.settings.readingTextAlign} !important;
			}
			.markdown-preview-view.markdown-rendered.reading-mode a {
				color: #007acc !important;
			}
		`;
	}

	/**
	 * Toggles reading mode by adding/removing the "reading-mode" class.
	 */
	private toggleReadingMode() {
		this.isReadingMode = !this.isReadingMode;
		(document.querySelectorAll(".markdown-preview-view.markdown-rendered") as NodeListOf<HTMLElement>)
			.forEach((el) => el.classList.toggle("reading-mode", this.isReadingMode));
		new Notice(`Reading Mode ${this.isReadingMode ? "Activated" : "Deactivated"}`);
	}

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

		const meta = this.parseMetaInfo(doc);
		this.footnotes = this.parseFootnotes(doc);
		const imageMap = this.extractImages(doc);
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
			topSections.forEach((sec) => allRootSections.push(this.parseSectionRecursive(sec, 1)));
		}
		const flatSections: SectionData[] = [];
		this.flattenSections(allRootSections, flatSections);
		const mdLines: string[] = [];
		this.addFrontMatter(mdLines, meta);
		await this.addCover(mdLines, meta, imageMap, file.basename);
		this.addTableOfContents(mdLines, flatSections);
		await this.addSections(mdLines, flatSections, imageMap, file.basename);
		if (this.footnotes.size > 0) {
			mdLines.push("\n## Footnotes\n");
			for (const [fnId, fnText] of this.footnotes.entries()) {
				mdLines.push(`[^${fnId}]: ${fnText}`);
			}
		}
		const formattedBaseName = this.getFormattedMDFileName(meta, file.basename);
		const outputFilePath = await this.getAvailableMdPath(formattedBaseName);
		const finalText = mdLines.join("\n\n");
		await this.app.vault.create(outputFilePath, finalText);
		this.app.workspace.openLinkText(outputFilePath, "", false);
		new Notice(`FB2 converted: ${outputFilePath}`);
	}

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
			coverHref = titleInfo.querySelector("coverpage > image[l\\:href]")?.getAttribute("l:href")?.replace(/^#/, "").toLowerCase() ?? "";
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
		const title = sectionEl.querySelector(":scope > title > p")?.textContent?.trim() ||
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

	private async addCover(mdLines: string[], meta: BookMetaInfo, imageMap: Map<string, { id: string; contentType: string; data: string }>, bookName: string) {
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
		mdLines.push("# Contents");
		sections.forEach((sec) => {
			const title = sec.title.trim();
			if (title) mdLines.push(`- [[#${title}|${title}]]`);
		});
	}

	private async addSections(mdLines: string[], sections: SectionData[], imageMap: Map<string, { id: string; contentType: string; data: string }>, bookName: string) {
		for (const sec of sections) {
			const headingLevel = Math.min(sec.level + 1, 6);
			const title = sec.title.trim();
			mdLines.push(title ? `\n${"#".repeat(headingLevel)} ${title}` : "\n");
			for (const epigraphEl of sec.epigraphs) {
				const paragraphs = Array.from(epigraphEl.querySelectorAll("p"));
				mdLines.push(">");
				paragraphs.forEach((p) => {
					mdLines.push(`> ${this.processFB2Paragraph(p)}`);
				});
				mdLines.push(">");
			}
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

	private async saveImageToVault(bookName: string, image: { id: string; contentType: string; data: string }): Promise<string> {
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

	private getFormattedMDFileName(meta: BookMetaInfo, fallbackName: string): string {
		let baseName = fallbackName;
		if (meta.title || meta.authors.length > 0) {
			let authorsPart = "";
			if (meta.authors.length === 1) {
				authorsPart = meta.authors[0];
			} else if (meta.authors.length >= 2) {
				authorsPart = meta.authors.slice(0, 2).join(", ");
				if (meta.authors.length > 2) {
					authorsPart += " et al.";
				}
			}
			baseName = authorsPart ? `${authorsPart} – ${meta.title}` : meta.title;
		}
		return baseName.replace(/[\\\/:*?"<>|]/g, "");
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

	async loadSettings() {
		const data: PluginData | null = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData({
			...this.settings
		});
	}

	private async savePluginData() {
		await this.saveData({
			...this.settings
		});
	}

	/* ============================== */
	/* ===== Quote Handling ===== */
	/* ============================== */

	private async handleSaveQuote(view: MarkdownView) {
		const editor = view.editor;
		let selectedText = editor.getSelection().trim();
		if (!selectedText) {
			new Notice("No text selected!");
			return;
		}
		const bookFile = view.file;
		if (!bookFile) {
			new Notice("Could not determine current file.");
			return;
		}
		const blockId = Math.random().toString(36).substr(2, 8);
		const blockIdRegex = /\n\^\w{8,}/;
		if (!blockIdRegex.test(selectedText)) {
			editor.replaceSelection(selectedText + `\n^${blockId}`);
			selectedText += `\n^${blockId}`;
		}
		const quotesFileName = `${bookFile.basename}-quotes.md`;
		const quotesFolder = this.settings.quotesFolderPath.trim();
		const quotesFilePath = quotesFolder ? `${quotesFolder}/${quotesFileName}` : quotesFileName;
		const formattedQuote = selectedText
			.split("\n")
			.map((line) => line.startsWith("^") ? line : `> ${line.trim()}`)
			.join("\n");
		const now = new Date();
		const timeStamp = now.toLocaleString();
		const linkText = this.app.metadataCache.fileToLinktext(bookFile, "");
		const sourceLink = `[[${linkText}#^${blockId}]]`;
		const quoteEntry = `\n\n### Quote from ${timeStamp}\n\n${formattedQuote}\n\n_Source: ${sourceLink}_\n`;
		let existingContent = "";
		const existingFile = this.app.vault.getAbstractFileByPath(quotesFilePath);
		if (existingFile) {
			try {
				existingContent = await this.app.vault.read(existingFile as TFile);
			} catch (error) {
				console.error("Error reading quote file:", error);
			}
		} else {
			existingContent =
				`# Quotes for: ${bookFile.basename}\n` +
				`_File created ${timeStamp}_\n\n---\n`;
		}
		const newContent = existingContent + quoteEntry;
		try {
			if (existingFile) {
				await this.app.vault.modify(existingFile as TFile, newContent);
			} else {
				if (quotesFolder) {
					await this.ensureFolderExists(quotesFolder);
				}
				await this.app.vault.create(quotesFilePath, newContent);
			}
			new Notice(`Quote saved to ${quotesFilePath}`);
		} catch (error) {
			new Notice("Error saving quote");
			console.error("Error while saving quote:", error);
		}
	}
}

/* ============================== */
/* ======= UI Modals ====== */
/* ============================== */

class FB2FileSuggestModal extends SuggestModal<TFile> {
	plugin: FB2ReaderPlugin;
	constructor(app: App, plugin: FB2ReaderPlugin) {
		super(app);
		this.plugin = plugin;
	}
	getSuggestions(query: string): TFile[] {
		let fb2Files = this.app.vault.getAllLoadedFiles().filter(
			(file): file is TFile => file instanceof TFile && file.extension === "fb2"
		);
		if (this.plugin.settings.fb2BaseFolderPath) {
			fb2Files = fb2Files.filter((file) =>
				file.path.startsWith(this.plugin.settings.fb2BaseFolderPath)
			);
		}
		if (!query) return fb2Files;
		return fb2Files.filter((file) =>
			file.path.toLowerCase().includes(query.toLowerCase())
		);
	}
	renderSuggestion(file: TFile, el: HTMLElement) {
		el.createEl("div", { text: file.path });
	}
	onChooseSuggestion(file: TFile) {
		this.plugin.convertFB2(file);
	}
}

class FolderSelectModal extends Modal {
	onSelect: (folderPath: string) => void;
	constructor(app: App, onSelect: (folderPath: string) => void) {
		super(app);
		this.onSelect = onSelect;
	}
	getAllFolders(folder?: TFolder, indent: string = ""): { folder: TFolder; display: string }[] {
		const results: { folder: TFolder; display: string }[] = [];
		if (!folder) {
			folder = this.app.vault.getRoot();
		}
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				results.push({ folder: child, display: indent + child.name });
				results.push(...this.getAllFolders(child, indent + "  "));
			}
		}
		return results;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Select Folder" });
		const folders = this.getAllFolders();
		if (folders.length === 0) {
			contentEl.createEl("p", { text: "No folders available." });
			return;
		}
		folders.forEach((item) => {
			const btn = contentEl.createEl("button", { text: item.display });
			btn.style.display = "block";
			btn.style.margin = "5px 0";
			btn.addEventListener("click", () => {
				this.close();
				this.onSelect(item.folder.path);
			});
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Modal for entering a custom font family.
 */
class CustomFontModal extends Modal {
	onChoose: (fontFamily: string) => void;
	constructor(app: App, onChoose: (fontFamily: string) => void) {
		super(app);
		this.onChoose = onChoose;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Enter Custom Font Family" });
		const input = contentEl.createEl("input", { type: "text", placeholder: "e.g., 'Comic Sans MS'" });
		input.style.width = "100%";
		input.style.marginBottom = "10px";
		const submitBtn = contentEl.createEl("button", { text: "Submit" });
		submitBtn.style.display = "block";
		submitBtn.addEventListener("click", () => {
			const val = input.value.trim();
			if (val) {
				this.onChoose(val);
				this.close();
			} else {
				new Notice("Please enter a font family name.");
			}
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ============================== */
/* ===== Plugin Settings Tab ===== */
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
		containerEl.createEl("h3", { text: "FB2 Converter & Quotes Settings" });

		new Setting(containerEl)
			.setName("Image Folder Path")
			.setDesc("Specify the folder for storing images from FB2 files. Example: books/imgs")
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
			.setDesc("Specify the folder where converted .md files will be stored. Example: books/output")
			.addText((text) =>
				text
					.setPlaceholder("output")
					.setValue(this.plugin.settings.outputFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.outputFolderPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Quotes Folder Path")
			.setDesc("Specify the folder where quote files will be saved. Example: quotes")
			.addText((text) =>
				text
					.setPlaceholder("quotes")
					.setValue(this.plugin.settings.quotesFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.quotesFolderPath = value.trim() || "quotes";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("FB2 Base Folder Path")
			.setDesc("Specify the base folder (relative to the Vault root) for FB2 file search. Leave empty to search the entire Vault.")
			.addText((text) =>
				text
					.setPlaceholder("e.g., books/fb2")
					.setValue(this.plugin.settings.fb2BaseFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.fb2BaseFolderPath = value.trim();
						await this.plugin.saveSettings();
					})
			)
			.addButton((btn) => {
				btn.setButtonText("Select Folder");
				btn.onClick(() => {
					new FolderSelectModal(this.app, (folderPath: string) => {
						this.plugin.settings.fb2BaseFolderPath = folderPath;
						this.plugin.saveSettings();
						this.display(); // re-render settings tab to update value
					}).open();
				});
			});

		containerEl.createEl("h3", { text: "Custom Reading Styles" });
		const sampleEl = containerEl.createEl("div", {
			text:
				"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.",
		});
		sampleEl.style.cssText =
			"padding: 10px; border: 1px solid var(--background-modifier-border); margin-bottom: 10px;" +
			`font-size: ${this.plugin.settings.readingFontSize}; ` +
			`color: ${this.plugin.settings.readingFontColor}; ` +
			`background: ${this.plugin.settings.readingBackgroundColor}; ` +
			`line-height: ${this.plugin.settings.readingLineHeight}; ` +
			`font-family: ${this.plugin.settings.readingFontFamily}; ` +
			`text-align: ${this.plugin.settings.readingTextAlign};`;

		new Setting(containerEl)
			.setName("Reading Font Size")
			.setDesc("Select font size (10 to 36 px)")
			.addText((text) => {
				text.inputEl.type = "range";
				text.inputEl.min = "10";
				text.inputEl.max = "36";
				text.inputEl.step = "1";
				const currentSize = parseInt(this.plugin.settings.readingFontSize, 10) || 16;
				text.setValue(currentSize.toString());
				text.inputEl.addEventListener("input", (e) => {
					const val = (e.target as HTMLInputElement).value;
					sampleEl.style.fontSize = val + "px";
					this.plugin.settings.readingFontSize = val + "px";
					this.plugin.updateReadingModeStyle();
				});
				text.onChange(async (value) => {
					this.plugin.settings.readingFontSize = value + "px";
					await this.plugin.saveSettings();
					this.plugin.updateReadingModeStyle();
				});
			});

		new Setting(containerEl)
			.setName("Reading Font Color")
			.setDesc("Select font color")
			.addText((text) => {
				text.inputEl.type = "color";
				text.setValue(this.plugin.settings.readingFontColor);
				text.onChange(async (value) => {
					this.plugin.settings.readingFontColor = value.trim() || "#333";
					await this.plugin.saveSettings();
					this.plugin.updateReadingModeStyle();
					sampleEl.style.color = this.plugin.settings.readingFontColor;
				});
			});

		new Setting(containerEl)
			.setName("Reading Background Color")
			.setDesc("Select background color")
			.addText((text) => {
				text.inputEl.type = "color";
				text.setValue(this.plugin.settings.readingBackgroundColor);
				text.onChange(async (value) => {
					this.plugin.settings.readingBackgroundColor = value.trim() || "#f5f5f5";
					await this.plugin.saveSettings();
					this.plugin.updateReadingModeStyle();
					sampleEl.style.background = this.plugin.settings.readingBackgroundColor;
				});
			});

		new Setting(containerEl)
			.setName("Reading Line Height")
			.setDesc("Enter line height (e.g., 1.5)")
			.addText((text) => {
				text.setValue(this.plugin.settings.readingLineHeight);
				text.onChange(async (value) => {
					this.plugin.settings.readingLineHeight = value.trim() || "1.5";
					await this.plugin.saveSettings();
					this.plugin.updateReadingModeStyle();
					sampleEl.style.lineHeight = this.plugin.settings.readingLineHeight;
				});
			});

		new Setting(containerEl)
			.setName("Reading Font Family")
			.setDesc("Select a font family or choose custom")
			.addDropdown((dropdown) => {
				const predefinedFonts = ["sans-serif", "serif", "monospace", "Arial", "Verdana", "Times New Roman", "Custom..."];
				predefinedFonts.forEach((font) => dropdown.addOption(font, font));
				// If current value is not in the predefined list, treat it as custom.
				if (!predefinedFonts.includes(this.plugin.settings.readingFontFamily)) {
					dropdown.setValue("Custom...");
				} else {
					dropdown.setValue(this.plugin.settings.readingFontFamily);
				}
				dropdown.onChange(async (value) => {
					if (value === "Custom...") {
						new CustomFontModal(this.app, (customFont: string) => {
							this.plugin.settings.readingFontFamily = customFont;
							this.plugin.saveSettings();
							this.plugin.updateReadingModeStyle();
							sampleEl.style.fontFamily = customFont;
							dropdown.setValue(customFont);
						}).open();
					} else {
						this.plugin.settings.readingFontFamily = value;
						await this.plugin.saveSettings();
						this.plugin.updateReadingModeStyle();
						sampleEl.style.fontFamily = value;
					}
				});
			});

		new Setting(containerEl)
			.setName("Reading Text Align")
			.setDesc("Select text alignment")
			.addDropdown((dropdown) => {
				dropdown.addOption("left", "Left");
				dropdown.addOption("center", "Center");
				dropdown.addOption("right", "Right");
				dropdown.addOption("justify", "Justify");
				dropdown.setValue(this.plugin.settings.readingTextAlign);
				dropdown.onChange(async (value) => {
					this.plugin.settings.readingTextAlign = value;
					await this.plugin.saveSettings();
					this.plugin.updateReadingModeStyle();
					sampleEl.style.textAlign = value;
				});
			});
	}
}
