import { camelOf, namesOf, type Names } from "./names.js";
import { render, vars, type McpSpec } from "./plan.js";
import type { FileToWrite } from "./write.js";

export interface McpParts {
  readonly files: FileToWrite[];
  /** the server class and its module (without .js), relative to the workflow folder */
  readonly server: string;
  readonly serverModule: string;
  /** the MCP tool class and its module */
  readonly tool: string;
  readonly toolModule: string;
}

/** An MCP server (`<name>.server.ts`) and one MCP tool calling it (`<tool>.mcp.ts`). */
export function mcpFiles(dir: string, mcp: Exclude<McpSpec, { kind: "none" }>): McpParts {
  const n = namesOf(mcp.name);
  const filesystem = mcp.kind === "filesystem";
  const tool = namesOf(filesystem ? `read ${mcp.name}` : `${mcp.name} ${mcp.tool}`);
  const serverTool = filesystem ? "read_text_file" : mcp.tool;
  const typeName = filesystem ? "" : namesOf(mcp.tool).pascal;
  const types = filesystem
    ? { input: "FileRead", output: "FileContent" }
    : { input: `${typeName}Args`, output: `${typeName}Reply` };
  const serverFile = filesystem
    ? render("mcp/filesystem.server.ts.tmpl", { ...vars(n), dir: mcp.dir })
    : render("mcp/command.server.ts.tmpl", {
        ...vars(n),
        command: mcp.command,
        serverTool,
        toolPascal: typeName,
      });
  const description = filesystem
    ? `Read a text file in ${mcp.dir} (absolute path).`
    : `${tool.title} (TODO: say what it does)`;
  const toolFile = render("mcp/tool.mcp.ts.tmpl", {
    ...vars(tool),
    ...types,
    serverPascal: n.pascal,
    serverCamel: camelOf(n),
    serverKebab: n.kebab,
    serverTool,
    description,
  });
  return {
    files: [
      { path: `${dir}/mcp/${n.kebab}.server.ts`, content: serverFile },
      { path: `${dir}/mcp/${tool.kebab}.mcp.ts`, content: toolFile },
    ],
    server: `${n.pascal}Server`,
    serverModule: `mcp/${n.kebab}.server`,
    tool: `${tool.pascal}Tool`,
    toolModule: `mcp/${tool.kebab}.mcp`,
  };
}

/** A knowledge base and the folder it indexes: `<name>-rag`, class `<Name>Rag`, `rag/<name>.rag.ts`. */
export function ragFiles(
  dir: string,
  rag: { readonly name: Names; readonly folder: string },
): { files: FileToWrite[]; knowledge: string } {
  const n = rag.name;
  const variables = { ...vars(n), folder: rag.folder };
  return {
    files: [
      { path: `${dir}/rag/${n.kebab}.rag.ts`, content: render("rag/knowledge.ts.tmpl", variables) },
      { path: `${rag.folder}/README.md`, content: render("rag/note.md.tmpl", variables) },
    ],
    knowledge: `${n.pascal}Rag`,
  };
}
