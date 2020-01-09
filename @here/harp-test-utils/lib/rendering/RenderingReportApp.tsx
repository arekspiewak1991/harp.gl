import * as React from "react";
import * as ReactDOM from "react-dom";
import { Report, summary } from "./RenderingReport";

function render(results: any, summaries: any) {
    ReactDOM.render(
        <Report results = {results} summary = {...summaries} />,
        document.getElementById("rendering-tests-report")
    );
}

fetch("/ibct-results")
    .then(response => response.json())
    .then(testResults => {
        const { summaries } = summary(testResults);
        render(testResults, summaries);
    });
