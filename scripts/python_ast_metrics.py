"""Deterministic Python metrics for the python.ast evaluator.

Reads {"root": "...", "files": ["a.py", ...]} on stdin and writes one JSON
object per file on stdout. Standard library only, so it runs anywhere a
python3 interpreter exists.
"""

import ast
import json
import sys

DECISIONS = (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.Assert)
COMPOUND = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try)
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
MUTABLE_DEFAULTS = (ast.List, ast.Dict, ast.Set, ast.ListComp, ast.DictComp, ast.SetComp)

if hasattr(ast, "TryStar"):
    COMPOUND = COMPOUND + (ast.TryStar,)
if hasattr(ast, "Match"):
    COMPOUND = COMPOUND + (ast.Match,)


def own_nodes(func):
    """Walk a function body without descending into nested functions or classes."""
    stack = list(ast.iter_child_nodes(func))
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, FUNCTIONS + (ast.ClassDef, ast.Lambda)):
            stack.extend(ast.iter_child_nodes(node))


def complexity(func):
    score = 1
    for node in own_nodes(func):
        if isinstance(node, DECISIONS):
            score += 1
        elif isinstance(node, ast.BoolOp):
            score += len(node.values) - 1
        elif isinstance(node, ast.comprehension):
            score += 1 + len(node.ifs)
        elif hasattr(ast, "match_case") and isinstance(node, ast.match_case):
            score += 1
    return score


def nesting(node, depth=0):
    deepest = depth
    for child in ast.iter_child_nodes(node):
        if isinstance(child, FUNCTIONS + (ast.ClassDef,)):
            continue
        inner = depth + 1 if isinstance(child, COMPOUND) else depth
        deepest = max(deepest, nesting(child, inner))
    return deepest


def param_count(func):
    args = func.args
    names = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
    if names and names[0] in ("self", "cls"):
        names = names[1:]
    return len(names) + (1 if args.vararg else 0) + (1 if args.kwarg else 0)


def is_silent(handler):
    body = handler.body
    return len(body) == 1 and (
        isinstance(body[0], ast.Pass)
        or (isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and body[0].value.value is Ellipsis)
    )


def analyse(path, source):
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        return {"file": path, "syntax_error": {"line": error.lineno or 1, "message": str(error.msg)}}

    result = {
        "file": path,
        "module_docstring": ast.get_docstring(tree) is not None,
        "functions": [],
        "bare_excepts": [],
        "silent_excepts": [],
        "mutable_defaults": [],
        "wildcard_imports": [],
        "global_statements": [],
    }
    for node in ast.walk(tree):
        if isinstance(node, FUNCTIONS):
            end = getattr(node, "end_lineno", node.lineno)
            result["functions"].append(
                {
                    "name": node.name,
                    "line": node.lineno,
                    "end_line": end,
                    "length": end - node.lineno + 1,
                    "complexity": complexity(node),
                    "params": param_count(node),
                    "nesting": nesting(node),
                    "has_docstring": ast.get_docstring(node) is not None,
                    "is_public": not node.name.startswith("_"),
                }
            )
            for default in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
                if isinstance(default, MUTABLE_DEFAULTS):
                    result["mutable_defaults"].append({"function": node.name, "line": default.lineno})
        elif isinstance(node, ast.ExceptHandler):
            if node.type is None:
                result["bare_excepts"].append(node.lineno)
            if is_silent(node):
                result["silent_excepts"].append(node.lineno)
        elif isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names):
            result["wildcard_imports"].append({"line": node.lineno, "module": node.module or "."})
        elif isinstance(node, ast.Global):
            result["global_statements"].append({"line": node.lineno, "names": node.names})
    return result


def main():
    request = json.load(sys.stdin)
    out = []
    for rel in request["files"]:
        try:
            with open(f"{request['root']}/{rel}", encoding="utf-8") as handle:
                out.append(analyse(rel, handle.read()))
        except (OSError, UnicodeDecodeError) as error:
            out.append({"file": rel, "read_error": str(error)})
    json.dump({"python": sys.version.split()[0], "files": out}, sys.stdout)


if __name__ == "__main__":
    main()
