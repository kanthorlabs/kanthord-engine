import assert from "node:assert/strict";
import { test } from "node:test";
import { isBoolean, isNumber, isObject, isString } from "./values.ts";

const primitiveValues = [undefined, null, true, false, 0, 1, NaN, "", "text"];
const objectValues = [{}, [], new Date(), new String("text"), new Number(1)];
const functionValue = () => {};

test("named type guards preserve primitive and object distinctions", () => {
  for (const value of ["", "text"]) {
    assert.equal(isString(value), true);
    assert.equal(isObject(value), false);
  }
  for (const value of [0, 1, NaN, Infinity]) {
    assert.equal(isNumber(value), true);
    assert.equal(isString(value), false);
  }
  for (const value of [true, false]) {
    assert.equal(isBoolean(value), true);
    assert.equal(isString(value), false);
  }
  for (const value of objectValues) {
    assert.equal(isObject(value), true);
    assert.equal(isString(value), false);
    assert.equal(isNumber(value), false);
    assert.equal(isBoolean(value), false);
  }
  for (const value of [...primitiveValues, functionValue]) {
    assert.equal(isObject(value), false);
  }
  for (const value of [undefined, null, 0, "false", "off", functionValue]) {
    assert.equal(isBoolean(value), false);
  }
  for (const value of [undefined, null, true, false, functionValue]) {
    assert.equal(isString(value), false);
    assert.equal(isNumber(value), false);
  }
});
