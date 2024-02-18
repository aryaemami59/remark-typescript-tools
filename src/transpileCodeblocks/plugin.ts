import type { Plugin } from 'unified';
import type { Node, Parent } from 'unist';
import visit from 'unist-util-visit';
// @ts-ignore
import flatMap from 'unist-util-flatmap';
import type { VFile } from 'vfile';
import { Compiler, CompilerSettings, TranspiledFile } from './compiler';
import {
  postProcessTranspiledJs as defaultPostProcessTranspiledJs,
  postProcessTs as defaultPostProcessTs,
} from './postProcessing';

export interface VirtualFile {
  code: string;
  skip?: boolean;
}
export type VirtualFiles = Record<string, VirtualFile>;

interface CodeNode extends Node {
  lang: string;
  meta: string | null;
  value: string;
  indent: number[];
}

type PostProcessor = (
  files: VirtualFiles,
  parentFile?: string,
  defaultProcessor?: PostProcessor
) => Promise<VirtualFiles>;

export interface Settings {
  compilerSettings: CompilerSettings;
  postProcessTranspiledJs?: PostProcessor;
  postProcessTs?: PostProcessor;
  assembleReplacementNodes?: typeof defaultAssembleReplacementNodes;
  fileExtensions?: string[];
}

const compilers = new WeakMap<CompilerSettings, Compiler>();

export const attacher: Plugin<[Settings]> = ({
  compilerSettings,
  postProcessTranspiledJs = defaultPostProcessTranspiledJs,
  postProcessTs = defaultPostProcessTs,
  assembleReplacementNodes = defaultAssembleReplacementNodes,
  fileExtensions = ['.mdx'],
}) => {
  if (!compilers.has(compilerSettings)) {
    compilers.set(compilerSettings, new Compiler(compilerSettings));
  }
  const compiler = compilers.get(compilerSettings)!;

  return function transformer(tree, file) {
    if (!file.extname || !fileExtensions.includes(file.extname)) {
      return tree;
    }

    const virtualFilepath =
      compilerSettings.transformVirtualFilepath?.(file.path ?? '') ?? file.path;

    let hasTabsImport = false;
    let hasTabItemImport = false;

    visit<Node & { value: string }>(tree, 'import', (node) => {
      if (/\bTabs\b/.test(node.value)) hasTabsImport = true;
      if (/\bTabItem\b/.test(node.value)) hasTabItemImport = true;
    });

    visit<Parent>(tree, 'root', (node) => {
      if (!hasTabsImport) {
        node.children.unshift({
          type: 'import',
          // @ts-ignore
          value: `import Tabs from '@theme/Tabs'`,
        });
      }
      if (!hasTabItemImport) {
        node.children.unshift({
          type: 'import',
          // @ts-ignore
          value: `import TabItem from '@theme/TabItem'`,
        });
      }
    });

    let codeBlock = 0;

    return flatMap(tree, async function mapper(node: CodeNode): Promise<Node[]> {
      if (node.type === 'code') {
        codeBlock++;
      }
      if (!(node.type === 'code' && ['ts', 'tsx'].includes(node.lang))) {
        return [node];
      }
      const tags = node.meta ? node.meta.split(' ') : [];
      if (tags.includes('no-transpile')) {
        return [node];
      }

      const virtualFolder = `${virtualFilepath}/codeBlock_${codeBlock}`;
      const virtualFiles = splitFiles(node.value, virtualFolder);

      //console.time(virtualFolder)
      const transpilationResult = compiler.compile(virtualFiles);
      //console.timeEnd(virtualFolder)

      for (const [fileName, result] of Object.entries(transpilationResult)) {
        for (const diagnostic of result.diagnostics) {
          if (diagnostic.line && node.position) {
            const lines = result.code
              .split('\n')
              .map(
                (line, lineNo) => `${String(lineNo).padStart(3, ' ')}  ${line}`
              );

            file.fail(
              `
TypeScript error in code block in line ${diagnostic.line} of ${fileName}
${diagnostic.message}

${lines.slice(Math.max(0, diagnostic.line - 5), diagnostic.line + 6).join('\n')}
            `,
              {
                line: diagnostic.line + node.position.start.line,
                column: diagnostic.character,
              }
            );
          } else {
            file.fail(diagnostic.message, node);
          }
        }
      }

      return await assembleReplacementNodes(
        node,
        file,
        virtualFolder,
        virtualFiles,
        transpilationResult,
        postProcessTs,
        postProcessTranspiledJs
      );
    });
  };
};

export async function defaultAssembleReplacementNodes(
  node: CodeNode,
  file: VFile,
  virtualFolder: string,
  virtualFiles: Record<string, VirtualFile>,
  transpilationResult: Record<string, TranspiledFile>,
  postProcessTs: PostProcessor,
  postProcessTranspiledJs: PostProcessor
): Promise<Node[]> {
  return [
    {
      type: 'jsx',
          // @ts-ignore
      value: `
    <Tabs
      groupId="language"
      defaultValue="ts"
      values={[
        { label: 'TypeScript', value: 'ts', },
        { label: 'JavaScript', value: 'js', },
      ]}
    >
        <TabItem value="ts">`,
    },
    {
      ...node,
          // @ts-ignore
      value: rearrangeFiles(
        await postProcessTs(virtualFiles, file.path, defaultPostProcessTs),
        virtualFolder
      ),
    },
    {
      type: 'jsx',
          // @ts-ignore
      value: `
        </TabItem>
        <TabItem value="js">`,
    },
    {
      ...node,
      lang: 'js',
      ...(typeof node.meta === 'string' && {
        meta: node.meta.replace(/(title=['"].*)\.t(sx?)(.*")/, '$1.j$2$3'),
      }),
          // @ts-ignore
      value: rearrangeFiles(
        await postProcessTranspiledJs(
          transpilationResult,
          file.path,
          defaultPostProcessTranspiledJs
        ),
        virtualFolder
      ),
    },
    {
      type: 'jsx',
          // @ts-ignore
      value: `
        </TabItem>
    </Tabs>`,
    },
  ];
}

function splitFiles(fullCode: string, folder: string) {
  const regex = /^\/\/ file: ([\w\-./\[\]]+)(?: (.*))?\s*$/gm;
  let match = regex.exec(fullCode);

  const files: VirtualFiles = {};

  do {
    const start = match ? match.index + match[0].length + 1 : 0;
    const fileName = match ? match[1] : 'index.ts';
    const flags = (match ? match[2] || '' : '').split(' ');
    const skip = flags.includes('noEmit');
    match = regex.exec(fullCode);
    const end = match ? match.index : fullCode.length;
    const code = fullCode.substring(start, end);
    files[`${folder}/${fileName}`] = { code, skip };
  } while (match);

  return files;
}

function rearrangeFiles(files: VirtualFiles, folder: string) {
  const filteredFiles = Object.entries(files).filter(([, { skip }]) => !skip);

  if (filteredFiles.length === 1) {
    const [[, { code }]] = filteredFiles;
    return code;
  }

  return filteredFiles
    .map(
      ([fileName, { code }]) => `// file: ${fileName.replace(`${folder}/`, '')}
${code.trim()}`
    )
    .join('\n\n\n');
}
