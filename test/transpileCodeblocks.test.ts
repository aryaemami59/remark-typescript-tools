import type { Code, Literal, Node, Parent } from 'mdast';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import mdxPlugin from 'remark-mdx';
import remarkParser from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import {
  transpileCodeblocks,
  TranspileCodeblocksSettings,
} from '../src/index.js';

const isCodeNode = (node: Node): node is Code => {
  return node.type === 'code';
};

const isParent = (node: Node): node is Parent => {
  return 'children' in node;
};

const isLiteral = (node: Node): node is Literal => {
  return 'value' in node;
};

const getResults = (node: Node | Code) => {
  if (node && 'value' in node) {
    return node.value;
  }
  // console.dir({ node }, { depth: null });
  // console.log(Object.keys(node));
  if (isCodeNode(node)) {
    const results =
      '```' +
      node.lang +
      (node.meta ? ' ' + node.meta : '') +
      '\n' +
      node.value +
      '\n```';

    // console.log({ results });

    return results;
  }
  if (node.type === 'root') {
    // console.log(node.children);

    // if ('value' in node) {
    //   return node.value;
    // }

    if ('children' in node && node.children && Array.isArray(node.children)) {
      return node.children.map(getResults).join('\n');
    }

    const results = node.children
      ? node.children.map((e) => e?.value).join('\n')
      : node.value;

    return results;
  }
  if (isParent(node)) {
    const results = node.children
      ? node.children.map((e) => e?.value).join('\n')
      : node.value;
    // console.log({ results });
    return results;
  }
  if ('value' in node) {
    return node.value;
  }
  return node.value;
};

// test.addSnapshotSerializer({
//   test(value) {
//     return value && value.type;
//   },
//   print(value, serialize) {
//     if (value.type === 'code') {
//       return (
//         '```' +
//         value.lang +
//         (value.meta ? ' ' + value.meta : '') +
//         '\n' +
//         value.value +
//         '\n```'
//       );
//     }
//     return value.children
//       ? value.children.map(serialize).join('\n')
//       : value.value;
//   },
// });

const defaultSettings: TranspileCodeblocksSettings = {
  compilerSettings: {
    tsconfig: resolve(import.meta.dirname, '..', 'tsconfig.tests.json'),
    externalResolutions: {
      'remark-typescript-tools': {
        resolvedPath: resolve(import.meta.dirname, '..', 'src'),
        packageId: {
          name: 'remark-typescript-tools',
          subModuleName: '',
          version: '1.0',
        },
      },
    },
  },
};

function getParser(settings = defaultSettings) {
  return unified()
    .use(remarkParser)
    .use(mdxPlugin)
    .use(transpileCodeblocks, settings)
    .use(remarkStringify);
}

function transform(md: string, parser = getParser()) {
  return parser.run(parser.parse(md), {
    path: import.meta.dirname + '/test.mdx',
  });
}

test('transpiles codeblocks', async () => {
  const md = `
\`\`\`ts
function testFn(arg1: string) {
    return arg1;
}
\`\`\`
`;

  // console.log(Object.keys(await transform(md)));

  assert.strictEqual(
    getResults(await transform(md)),
    `import TabItem from '@theme/TabItem'\nimport Tabs from '@theme/Tabs'`
  );
});

test('inserts imports for Tabs & TabItem', async () => {
  const md = `
# some-pararaph
`;

  // console.log(Object.keys(await transform(md)));
  assert.strictEqual(
    getResults(await transform(md)),
    `import TabItem from '@theme/TabItem'\nimport Tabs from '@theme/Tabs'\nsome-pararaph`
  );
});

test('skips imports that are already present', async () => {
  const md = `
# some-pararaph

import Tabs from '@theme/Tabs'
`;

  console.log((await transform(md)).type, 'AAAA');

  assert.strictEqual(
    getResults(await transform(md)),
    `import TabItem from '@theme/TabItem'\nsome-pararaph\nimport Tabs from '@theme/Tabs'`
  );
});

test('throws an error on compilation error', async ({ assert }) => {
  const md = `
\`\`\`ts
let x: string = 5
\`\`\`
`;

  await assert.rejects(
    transform(md).catch((e) => {
      throw e.toString();
    }),
    `remark-typescript-tools/test/test.mdx:2:1-4:4: Type '5' is not assignable to type 'string'.`
  );
});

test('no-transpile does not throw an error and does add tabs', async ({
  assert,
}) => {
  const md = `
\`\`\`ts no-transpile
let x: string = 5
\`\`\`
`;

  await assert.doesNotReject(
    transform(md),
    `
          import TabItem from '@theme/TabItem'
          import Tabs from '@theme/Tabs'
          \`\`\`ts no-transpile
          let x: string = 5
          \`\`\`
        `
  );
});

test('transpiles codeblocks with multiple file definitions', async () => {
  const md = `
\`\`\`ts
// file: file1.ts
export function testFn(arg1: string) {
    return arg1;
}
// file: file2.ts
import { testFn } from './file1'

console.log(testFn("foo"))
\`\`\`
`;

  assert.strictEqual(
    getResults(await transform(md)),
    `import TabItem from '@theme/TabItem'\nimport Tabs from '@theme/Tabs'`
  );
});

test('finds error spanning over multiple files', async ({ assert }) => {
  const md = `
\`\`\`ts
// file: file1.ts
export function testFn(arg1: string) {
    return arg1;
}
// file: file2.ts
import { testFn } from './file1'

console.log(testFn(5))
\`\`\`
`;

  await assert.rejects(
    transform(md).catch((e) => {
      throw e.toString();
    }),
    `/remark-typescript-tools/test/test.mdx/codeBlock_1/file2.ts
Argument of type '5' is not assignable to parameter of type 'string'.`
  );
});

test('takes "noEmit" files into account for compiling, but does not output them', async () => {
  const md = `
\`\`\`ts
// file: file1.ts noEmit
export function testFn(arg1: string) {
    return arg1;
}
// file: file2.ts
import { testFn } from './file1'

console.log(testFn("foo"))
\`\`\`
`;

  // console.dir(await transform(md), { depth: null });

  assert.strictEqual(
    getResults(await transform(md)),
    'file1.ts should be missing from this snapshot'
  );
});

test('reports errors in "noEmit" files', async ({ assert }) => {
  const md = `
\`\`\`ts
// file: file1.ts noEmit
export function testFn(arg1: string) {
    let x: number = arg1;
    return x;
}
// file: file2.ts
import { testFn } from './file1'

console.log(testFn("foo"))
\`\`\`
`;

  await assert.rejects(
    transform(md).catch((e) => {
      throw e.toString();
    }),
    `remark-typescript-tools/test/test.mdx/codeBlock_1/file1.ts
Type 'string' is not assignable to type 'number'.`
  );
});

// test('supports hyphens, square brackets & periods in filenames', async () => {
//   const md = `
// \`\`\`ts
// // file: file-one.stuff.ts noEmit
// export function testFn(arg1: string) {
//     return arg1;
// }
// // file: [file2].ts
// import { testFn } from './file-one.stuff'

// console.log(testFn("foo"))
// \`\`\`
// `;

//   expect(await transform(md)).toMatchSnapshot();
// });
// export const someNumber = 5 as const;

// describe('imports defined via compilerOptions.paths', () => {
//   test('import', async () => {
//     const md = `
// \`\`\`ts
// // file: file1.ts
// import { someNumber } from "@transpileCodeblocksTest"
// const n: number = someNumber;
// // file: file2.ts
// import { someNumber } from "@test/transpileCodeblocks.test"
// const n: number = someNumber;
// \`\`\`
// `;
//     expect(await transform(md)).toMatchSnapshot();
//   });
//   test('import with errors', async () => {
//     const md = `
// \`\`\`ts
// import { someNumber } from "@test/transpileCodeblocks.test"
// const n: string = someNumber;
// \`\`\`
// `;
//     await expect(
//       transform(md).catch((e) => {
//         throw e.toString();
//       })
//     ).rejects
//       .toContain(`remark-typescript-tools/test/test.mdx/codeBlock_1/index.ts
// Type '5' is not assignable to type 'string'.`);
//   });
// });

// test('transpiles jsx', async () => {
//   const md = `
// \`\`\`ts
// // file: file2.tsx
// import React from 'react';

// console.log(<div>asd</div>)
// \`\`\`
// `;

//   expect(await transform(md)).toMatchSnapshot();
// });

// test('transpiles multiple jsx files', async () => {
//   const md = `
// \`\`\`ts
// // file: button.tsx
// import React from 'react';

// export const Button = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />;

// // file: file2.tsx
// import React from 'react';
// import { Button } from "./button";

// console.log(<Button>asd</Button>);

// \`\`\`
// `;
//   expect(await transform(md)).toMatchSnapshot();
// });

// test('transforms virtual filepath', async () => {
//   const md = `
//   \`\`\`ts
//   // file: file1.ts
//   export function testFn(arg1: string) {
//       return arg1;
//   }
//   // file: file2.ts
//   import { testFn } from './file1'

//   console.log(testFn(5))
//   \`\`\`
//   `;

//   const settings: TranspileCodeblocksSettings = {
//     ...defaultSettings,
//     compilerSettings: {
//       ...defaultSettings.compilerSettings,
//       transformVirtualFilepath: (path) =>
//         path.replace('/test/', '/replaced/path/'),
//     },
//   };

//   const parser = getParser(settings);

//   await expect(
//     transform(md, parser).catch((e) => {
//       throw e.toString();
//     })
//   ).rejects
//     .toContain(`/remark-typescript-tools/replaced/path/test.mdx/codeBlock_1/file2.ts
// Argument of type '5' is not assignable to parameter of type 'string'.`);
// });

// test('supports tsx snippets', async () => {
//   const md = `
// \`\`\`tsx title="App.tsx" showLineNumbers
// // file: App.tsx
// import React from 'react';
// export function App() {
//   const [counter, setCounter] = React.useState<number>(0);
//   return (
//     <div>
//       <button onClick={() => setCounter((prev) => prev + 1)}>
//         Increment counter ({counter})
//       </button>
//     </div>
//   )
// }
// `;

//   expect(await transform(md)).toMatchSnapshot();
// });
