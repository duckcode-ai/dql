import { parse, NodeKind } from '@duckcodeailabs/dql-core';
function exprValue(expr) {
    switch (expr.kind) {
        case NodeKind.StringLiteral: return expr.value;
        case NodeKind.NumberLiteral: return expr.value;
        case NodeKind.Identifier: return expr.name;
        default: return '';
    }
}
function namedArgsToViz(args) {
    const props = {};
    for (const arg of args) {
        props[arg.name] = exprValue(arg.value);
    }
    const chart = (props['chart'] ?? props['type'] ?? 'table');
    const y = props['y'];
    return {
        chart,
        x: props['x'],
        y: typeof y === 'string' ? y : undefined,
        color: props['color'],
        label: props['label'],
        value: props['value'],
        format: props['format'],
        title: props['title'],
    };
}
export function parseDQL(source) {
    const errors = [];
    let ast;
    try {
        ast = parse(source);
    }
    catch (e) {
        return { blocks: [], errors: [e instanceof Error ? e.message : 'Parse error'] };
    }
    const blocks = [];
    let idx = 0;
    for (const stmt of ast.statements) {
        // --- block "Name" { ... } ---
        if (stmt.kind === NodeKind.BlockDecl) {
            const b = stmt;
            if (!b.query?.rawSQL)
                continue;
            const params = {};
            if (b.params) {
                for (const p of b.params.params) {
                    params[p.name] = exprValue(p.initializer);
                }
            }
            const viz = b.visualization
                ? namedArgsToViz(b.visualization.properties)
                : null;
            blocks.push({
                id: `block-${idx++}`,
                name: b.name,
                sql: b.query.rawSQL.trim(),
                viz,
                params,
            });
        }
        // --- chart.bar(SELECT ..., x = col, y = col) ---
        if (stmt.kind === NodeKind.ChartCall) {
            const c = stmt;
            const viz = namedArgsToViz(c.args);
            viz.chart = c.chartType;
            blocks.push({
                id: `chart-${idx++}`,
                name: viz.title ?? `Chart ${idx}`,
                sql: c.query.rawSQL.trim(),
                viz,
                params: {},
            });
        }
    }
    return { blocks, errors };
}
