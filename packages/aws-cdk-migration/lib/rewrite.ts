import * as ts from 'typescript';

/**
 * Re-writes "hyper-modular" CDK imports (most packages in `@aws-cdk/*`) to the
 * relevant "mono" CDK import path. The re-writing will only modify the imported
 * library path, presrving the existing quote style, etc...
 *
 * Syntax errors in the source file being processed may cause some import
 * statements to not be re-written.
 *
 * Supported import statement forms are:
 * - `import * as lib from '@aws-cdk/lib';`
 * - `import { Type } from '@aws-cdk/lib';`
 * - `import '@aws-cdk/lib';`
 * - `import lib = require('@aws-cdk/lib');`
 * - `import { Type } = require('@aws-cdk/lib');
 * - `require('@aws-cdk/lib');
 *
 * @param sourceText the source code where imports should be re-written.
 * @param fileName   a customized file name to provide the TypeScript processor.
 *
 * @returns the updated source code.
 */
export function rewriteImports(sourceText: string, fileName: string = 'index.ts'): string {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2018);

  const replacements = new Array<{ original: ts.Node, updatedLocation: string }>();
  const importInsertions: string[] = [];

  const visitor = <T extends ts.Node>(node: T): ts.VisitResult<T> => {
    const moduleSpecifier = getModuleSpecifier(node);

    if (moduleSpecifier == null) {
      return node;
    }
    if (moduleSpecifier.module.text === '@aws-cdk/core' && moduleSpecifier.symbols?.includes('Construct')) {
      importInsertions.push(`${getIndent(node)}import { Construct } from \'constructs\';`);
    }
    const newTarget = moduleSpecifier && updatedLocationOf(moduleSpecifier.module.text);

    if (moduleSpecifier != null && newTarget != null) {
      replacements.push({ original: moduleSpecifier.module, updatedLocation: newTarget });
    }
    return node;
  };

  sourceFile.statements.forEach(node => ts.visitNode(node, visitor));

  let updatedSourceText = sourceText;
  // Applying replacements in reverse order, so node positions remain valid.
  for (const replacement of replacements.sort(({ original: l }, { original: r }) => r.getStart(sourceFile) - l.getStart(sourceFile))) {
    const prefix = updatedSourceText.substring(0, replacement.original.getStart(sourceFile) + 1);
    const suffix = updatedSourceText.substring(replacement.original.getEnd() - 1);

    updatedSourceText = prefix + replacement.updatedLocation + suffix;
  }
  for (const insertion of importInsertions) {
    updatedSourceText = insertion + '\n' + updatedSourceText;
  }

  return updatedSourceText;

  function getModuleSpecifier(node: ts.Node): { module: ts.StringLiteral, type: 'named' | 'namespace' | 'none', symbols?: string[] } | undefined {
    if (ts.isImportDeclaration(node)) {
      // import style
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        if (node.importClause == null) {
          // import from 'location';
          return { module: moduleSpecifier, type: 'none' };
        }
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          // import { foo, bar } from 'location';
          return { module: moduleSpecifier, type: 'named', symbols: bindings.elements.map(e => e.name.text) };
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          // import * as name from 'location';
          return { module: moduleSpecifier, type: 'namespace', symbols: [bindings.name.text] };
        }
      } else if (ts.isBinaryExpression(moduleSpecifier) && ts.isCallExpression(moduleSpecifier.right)) {
        // import { Type } = require('location');
        return getModuleSpecifier(moduleSpecifier.right); // TBD
      }
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      // import name = require('location');
      return { module: node.moduleReference.expression, type: 'none' }; // TBD
    } else if (
      (ts.isCallExpression(node))
      && ts.isIdentifier(node.expression)
      && node.expression.escapedText === 'require'
      && node.arguments.length === 1
    ) {
      // require('location');
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) {
        return { module: argument, type: 'none' };
      }
    } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      // require('location'); // This is an alternate AST version of it
      return getModuleSpecifier(node.expression);
    }
    return undefined;
  }

  function getIndent(node: ts.Node): string {
    const text = sourceText.substring(node.pos, node.end);
    const wsRe = /^[\n\r]*([\t ]+)/.exec(text);
    if (!wsRe) return '';
    return wsRe[1];
  }
}

const EXEMPTIONS = new Set([
  '@aws-cdk/cloudformation-diff',
]);

function updatedLocationOf(modulePath: string): string | undefined {
  if (!modulePath.startsWith('@aws-cdk/') || EXEMPTIONS.has(modulePath)) {
    return undefined;
  }

  if (modulePath === '@aws-cdk/core') {
    return 'aws-cdk-lib';
  }

  // These 2 are unchanged
  if (modulePath === '@aws-cdk/assert') {
    return '@aws-cdk/assert';
  }

  if (modulePath === '@aws-cdk/assert/jest') {
    return '@aws-cdk/assert/jest';
  }

  return `aws-cdk-lib/${modulePath.substring(9)}`;
}
