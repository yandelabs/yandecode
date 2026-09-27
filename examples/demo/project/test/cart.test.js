import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscount, cartTotal } from '../src/cart.js';

test('cartTotal multiplies price by quantity', () => {
  assert.equal(
    cartTotal([
      { price: 10, quantity: 3 },
      { price: 5, quantity: 1 },
    ]),
    35,
  );
});

test('applyDiscount takes a percentage off', () => {
  assert.equal(applyDiscount(200, 10), 180);
});
