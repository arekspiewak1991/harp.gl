/*
 * Copyright (C) 2017-2018 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { assert } from "chai";
import {
    pointInsideTileExtents,
    pointsAreFromDiagonalTileBorder,
    pointsAreToDiagonalTileBorder,
    pointsOnXAxisAlignedTileBorder,
    pointsOnYAxisAlignedTileBorder
} from "../lib/OutlineIndicesDetector";

describe("The OutlineIndicesDetector check if an index is needed", () => {
    const tileExtent = 1.0;
        describe("#pointInsideTileExtents", () => {
        it("returns true if the point is inside the tile extents", () => {
            assert.equal(pointInsideTileExtents(0.9, 0.9, tileExtent), true);
        });
        it("returns false if it is bigger than the tile extents", () => {
            assert.equal(pointInsideTileExtents(1.2, -1.0, tileExtent), false);
        });
    });

    describe("#pointsOnYAxisAlignedTileBorder", () => {
        it("returns true if the points are on the opposite horizontal borders", () => {
            assert.equal(pointsOnYAxisAlignedTileBorder(2.0, 0.99, 1.0, 0.9, tileExtent), true);
        });
        it("returns false if the points are in the same horizontal borders", () => {
            assert.equal(pointsOnYAxisAlignedTileBorder(1.0, 1.01, 1.0, 0.0, tileExtent), false);
        });
    });

    describe("#pointsOnXAxisAlignedTileBorder", () => {
        it("returns true if the points are on the opposite vertical borders", () => {
            assert.equal(pointsOnXAxisAlignedTileBorder(0.7, 2.0, -0.5, 1.0, tileExtent), true);
        });
        it("returns false if the points are on the same vertical border", () => {
            assert.equal(pointsOnXAxisAlignedTileBorder(0.7, 1.0, -0.5, 1.0, tileExtent), false);
        });
    });
    describe("#pointsAreToDiagonalTileBorder", () => {
        const msg =
            "returns true if a line goes diagonally from an upper tile on the y axis to the" +
            " vertical border of the tile";
        it(msg, () => {
            assert.equal(pointsAreToDiagonalTileBorder(0.7, 1.1, 1.0, 0.9, tileExtent), true);
        });
        it("returns false if the last point is not on the tile", () => {
            assert.equal(pointsAreToDiagonalTileBorder(0.7, 1.1, 0.5, 0.9, tileExtent), false);
        });
    });
    describe("#pointsAreFromDiagonalTileBorder", () => {
        const msg =
            "returns true if a line goes diagonally from the vertical border of the tile to" +
            " next tile on the y axis";
        it(msg, () => {
            assert.equal(pointsAreFromDiagonalTileBorder(1, 0.8, 0.8, 1.2, tileExtent), true);
        });
        it("returns false if a line moves diagonally inside the same tile", () => {
            assert.equal(pointsAreFromDiagonalTileBorder(1, 0.8, 0.8, 0.9, tileExtent), false);
        });
        it("returns false if it does not start on the tile", () => {
            assert.equal(pointsAreFromDiagonalTileBorder(0.7, 0.8, 0.8, 1.2, tileExtent), false);
        });
    });
});
