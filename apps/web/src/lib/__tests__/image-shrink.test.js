/**
 * The arithmetic behind shrinking a photo before it is uploaded. Pure on purpose: the canvas and the
 * browser decoders are plumbing, this is the part that can quietly distort an image.
 */
import { scaledDimensions } from "../imageShrink";
import { MAX_PHOTO_EDGE_PX } from "../../constants/limits";

describe("scaledDimensions", () => {
  test("a landscape camera photo is bounded by its long edge", () => {
    expect(scaledDimensions(4000, 3000)).toEqual({ width: 1600, height: 1200 });
  });

  test("a portrait photo is bounded by its (long) height", () => {
    expect(scaledDimensions(3000, 4000)).toEqual({ width: 1200, height: 1600 });
  });

  test("a square photo keeps its aspect", () => {
    expect(scaledDimensions(4000, 4000)).toEqual({ width: 1600, height: 1600 });
  });

  test("a photo already within the bound is left alone, never enlarged", () => {
    expect(scaledDimensions(800, 600)).toEqual({ width: 800, height: 600 });
    expect(scaledDimensions(MAX_PHOTO_EDGE_PX, 900)).toEqual({
      width: MAX_PHOTO_EDGE_PX,
      height: 900,
    });
  });

  test("rounding keeps whole pixels", () => {
    expect(scaledDimensions(3001, 2000)).toEqual({ width: 1600, height: 1066 });
  });

  test("a custom bound is honoured", () => {
    expect(scaledDimensions(1000, 500, 500)).toEqual({ width: 500, height: 250 });
  });

  test("a broken decode yields no canvas rather than NaN", () => {
    expect(scaledDimensions(0, 400)).toEqual({ width: 0, height: 0 });
    expect(scaledDimensions(400, 0)).toEqual({ width: 0, height: 0 });
  });
});
