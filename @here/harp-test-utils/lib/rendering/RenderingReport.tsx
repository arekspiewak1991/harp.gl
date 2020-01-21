/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { githubImageResolver } from "@here/harp-rendering-test/TestPathConfig";
import * as fs from "fs";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { ImageTestResultLocal } from "./Interface";

interface Summary {
    [prop: string]: number | boolean;
}

interface ReportProps {
    results: ImageTestResultLocal[];
    summary: Summary;
}

export function Report(props: ReportProps) {
    return (
        <div className="report">
            <div>
                <span>Success: {props.summary.success} </span>
                <span>Skipped: {props.summary.skipped} </span>
                <span>Failed: {props.summary.failed} </span>
            </div>
            {props.results.map((res, idx) => (
                <TestCase {...res} key={idx} />
            ))}
        </div>
    );
}

function TestCase(test: ImageTestResultLocal) {
    const props = test.imageProps;
    const referenceImageUrl = githubImageResolver(props);

    return (
        <div className="test-case">
            <div className="props">
                <span>Test: {props.name} - </span>
                <span>Platform: {props.platform}</span>
            </div>
            <img src={test.actualImagePath} alt={props.name} />
            <img src={referenceImageUrl} alt={props.name} />
            <img src={test.diffImagePath} alt={props.name} />
        </div>
    );
}

export async function generateHtmlReport(results: ImageTestResultLocal[]): Promise<string> {
    const summaries: Summary = summary(results);
    const resultsWithStaticImg = await getImagesDataUri(results);
    return renderToString(<Report results={resultsWithStaticImg} summary={summaries} />);
}

async function getImagesDataUri(results: ImageTestResultLocal[]) {
    const modifiedResults = [];
    for (const test of results) {
        let image;
        const actImgDataUri = test.actualImagePath
            ? await loadImageData(test.actualImagePath)
            : undefined;
        const diffImgDataUri = test.diffImagePath
            ? await loadImageData(test.diffImagePath)
            : undefined;
        image = {
            imageProps: test.imageProps,
            actualImagePath: actImgDataUri,
            diffImagePath: diffImgDataUri,
            passed: test.passed,
            mismatchedPixels: test.mismatchedPixels,
            approveDifference: test.approveDifference
        };
        modifiedResults.push(image);
    }
    return modifiedResults;
}

async function loadImageData(url: string) {
    const binaryImg = fs.readFileSync(url, "binary");
    const imageDataUri = new Buffer(binaryImg, "binary").toString("base64");
    return "data:image/png;base64," + imageDataUri;
}

export function summary(results: ImageTestResultLocal[]): Summary {
    let someTestsFailed = false;
    const res = results.reduce(
        (r, result) => {
            const status =
                result.mismatchedPixels === undefined
                    ? "skipped"
                    : result.passed
                    ? "success"
                    : "failed";
            if (status === "failed") {
                someTestsFailed = true;
            }
            Object.keys(result.imageProps).forEach(prop => {
                const value = result.imageProps[prop];
                const key = `${prop}=${value}`;
                if (!r[key]) {
                    r[key] = {
                        success: 0,
                        skipped: 0,
                        failed: 0
                    };
                }
                r[key][status] += 1;
            });
            r[status] += 1;

            return r;
        },
        {
            success: 0,
            skipped: 0,
            failed: 0
        } as any
    );
    return {
        summaries: res,
        someTestsFailed
    };
}
