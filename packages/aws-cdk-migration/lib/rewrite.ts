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

  const replacements = new Array<{ importNode: ts.Node, original: ts.Node, updatedLocation: string }>();
  let isConstructANamedImport = false;
  let constructQualifier: string | undefined;

  const visitor = <T extends ts.Node>(node: T): ts.VisitResult<T> => {
    const moduleSpecifier = getModuleSpecifier(node);
    const newTarget = moduleSpecifier && updatedLocationOf(moduleSpecifier.text);

    if (moduleSpecifier != null && newTarget != null) {
      replacements.push({ importNode: node, original: moduleSpecifier, updatedLocation: newTarget });

      if (moduleSpecifier.text === '@aws-cdk/core') {
        // Need to determine if we need to both:
        // (a) insert an import for constructs and (b) update any references to Construct
        isConstructANamedImport = namedImports(node).some(name => name === 'Construct');
        constructQualifier = importNamespaceQualifier(node);
      }
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

  return updatedSourceText;

  function getModuleSpecifier(node: ts.Node): ts.StringLiteral | undefined {
    if (ts.isImportDeclaration(node)) {
      // import style
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        // import from 'location';
        // import * as name from 'location';
        return moduleSpecifier;
      } else if (ts.isBinaryExpression(moduleSpecifier) && ts.isCallExpression(moduleSpecifier.right)) {
        // import { Type } = require('location');
        return getModuleSpecifier(moduleSpecifier.right);
      }
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      // import name = require('location');
      return node.moduleReference.expression;
    } else if (
      (ts.isCallExpression(node))
      && ts.isIdentifier(node.expression)
      && node.expression.escapedText === 'require'
      && node.arguments.length === 1
    ) {
      // require('location');
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) {
        return argument;
      }
    } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      // require('location'); // This is an alternate AST version of it
      return getModuleSpecifier(node.expression);
    }
    return undefined;
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

function namedImports(node: ts.Node): string[] {
  if (ts.isImportDeclaration(node)
    && node.importClause?.namedBindings
    && ts.isNamedImports(node.importClause?.namedBindings)) {
    return node.importClause.namedBindings.elements.map(e => e.name.text);
  }
  return [];
}

function importNamespaceQualifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node)
    && node.importClause?.namedBindings
    && ts.isNamespaceImport(node.importClause?.namedBindings)) {
    return node.importClause.namedBindings.name.text;
  } else if (ts.isImportEqualsDeclaration(node)) {
    return node.name.text;
  } else {
    return undefined;
  }
}
