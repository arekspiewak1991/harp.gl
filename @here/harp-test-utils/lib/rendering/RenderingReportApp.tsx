import * as React from "react";
import * as ReactDOM from "react-dom";
import { Report, summary } from "./RenderingReport";

function render(results: any, summaries: any) {
    ReactDOM.render(
            <html>
                <head>
                    <title>Report Static</title>
                    <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap" />
                </head>
                <body>
                    <Report results = {results} summary = { summaries } />
                </body>
            </html>,
        document.getElementById("rendering-tests-report")
    );
}

fetch("/ibct-results")
    .then(response => response.json())
    .then(testResults => {
        const summaries = summary(testResults);
        render(testResults, summaries);
    });
