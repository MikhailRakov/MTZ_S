/**
 * Общие утилиты для работы с модельными сетками.
 */

/**
 * Накопительные позиции границ ячеек: [0, c0, c0+c1, ...].
 * @param {number[]} cells — размеры ячеек вдоль оси
 * @returns {number[]} массив длины cells.length + 1
 */
export function calculatePositions(cells) {
    const positions = [0];
    let cumulative = 0;
    for (const cell of cells) {
        cumulative += cell;
        positions.push(cumulative);
    }
    return positions;
}

/** Суммарный размер (extent) оси по массиву ячеек. */
export function axisExtent(cells) {
    let total = 0;
    for (const cell of cells) total += cell;
    return total;
}
