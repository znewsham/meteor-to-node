import { walk } from 'estree-walker';

const contextChangingTypes = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
  // QUESTION: where else would `this` be valid?
]);
export default function maybeRewriteGlobalThis(ast, debug) {
  let ret = false;
  const currentContext = [ast];
  walk(ast, {
    enter(node) {
      if (contextChangingTypes.has(node.type)) {
        currentContext.push(node);
      }
      if (node.type === 'ThisExpression' && currentContext.length === 1) {
        node.__rewritten = true;
        node.type = 'Identifier';
        node.name = 'globalThis';
        ret = true;
      }
    },
    leave(node) {
      if (currentContext[currentContext.length - 1] === node) {
        currentContext.pop();
      }
    },
  });
  return ret;
}
