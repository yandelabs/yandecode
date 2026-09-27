/** Sum of line prices for a cart: price × quantity for each line. */
export function cartTotal(lines) {
  return lines.reduce((sum, line) => sum + line.price, 0);
}

/** Applies a percentage discount (0–100) to a total. */
export function applyDiscount(total, percent) {
  return Math.round(total * (100 - percent)) / 100;
}
