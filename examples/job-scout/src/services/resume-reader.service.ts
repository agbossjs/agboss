import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Injectable } from "@agboss/core";
import { extractText, getDocumentProxy } from "unpdf";
import {
  expandHome,
  FORMATS,
  isFormatExt,
  looseName,
  MAX_FILE_BYTES,
  resumeText,
  type PdfExtractor,
  type Resume,
} from "../helpers/resume.helper.js";

const extractPdf: PdfExtractor = async (bytes) => {
  const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
  return text;
};

/** Reads a resume from disk: PDF, Markdown or plain text; a slightly mangled path resolves in its folder. */
@Injectable()
export class ResumeReader {
  constructor(private readonly pdf: PdfExtractor = extractPdf) {}

  async read(path: string): Promise<Resume> {
    const resolved = await this.resolvePath(resolve(expandHome(path.trim())));
    const ext = extname(resolved.path).toLowerCase();
    if (!isFormatExt(ext))
      throw new Error(`Unsupported resume format "${ext}" — use .pdf, .md or .txt`);
    if ((await stat(resolved.path)).size > MAX_FILE_BYTES)
      throw new Error("Resume file is larger than 5 MB");
    const bytes = await readFile(resolved.path);
    const format = FORMATS[ext];
    const raw = format === "pdf" ? await this.pdf(new Uint8Array(bytes)) : bytes.toString("utf8");
    return { ...resolved, format, ...resumeText(raw) };
  }

  /**
   * Models sometimes mangle a path they copy (an extra underscore, a changed case). A missing file
   * resolves to the one supported file in the same folder whose name matches loosely; otherwise the
   * error lists what the folder has.
   */
  private async resolvePath(full: string): Promise<{ path: string; requestedPath?: string }> {
    if (
      await stat(full).then(
        () => true,
        () => false,
      )
    )
      return { path: full };
    const folder = dirname(full);
    const files = await readdir(folder).catch(() => {
      throw new Error(`No such file or folder: ${full}`);
    });
    const resumes = files.filter((file) => isFormatExt(extname(file).toLowerCase()));
    const matches = resumes.filter((file) => looseName(file) === looseName(basename(full)));
    const [only] = matches;
    if (only !== undefined && matches.length === 1)
      return { path: join(folder, only), requestedPath: full };
    const listed = resumes.length > 0 ? resumes.join(", ") : "no .pdf, .md or .txt files";
    throw new Error(`No such file: ${full}. Files in that folder: ${listed}`);
  }
}
