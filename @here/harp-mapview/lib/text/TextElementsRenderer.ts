/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import { LineMarkerTechnique, Theme } from "@here/harp-datasource-protocol";
import {
    AdditionParameters,
    DEFAULT_TEXT_CANVAS_LAYER,
    FontCatalog,
    MeasurementParameters,
    TextBufferAdditionParameters,
    TextCanvas,
    TextLayoutStyle,
    TextRenderStyle
} from "@here/harp-text-canvas";
import {
    assert,
    LoggerManager,
    LogLevel,
    Math2D,
    MathUtils,
    PerformanceTimer
} from "@here/harp-utils";
import * as THREE from "three";

import { Projection } from "@here/harp-geoutils";
import { DataSource } from "../DataSource";
import { debugContext } from "../DebugContext";
import { PickObjectType, PickResult } from "../PickHandler";
import { PoiManager } from "../poi/PoiManager";
import { PoiRenderer } from "../poi/PoiRenderer";
import { PoiRendererFactory } from "../poi/PoiRendererFactory";
import { IBox, LineWithBound, ScreenCollisions } from "../ScreenCollisions";
import { ScreenProjector } from "../ScreenProjector";
import { Tile } from "../Tile";
import { MapViewUtils } from "../Utils";
import { DataSourceTileList } from "../VisibleTileSet";
import { FontCatalogLoader } from "./FontCatalogLoader";
import {
    checkReadyForPlacement,
    computePointTextOffset,
    computeViewDistance,
    getMaxViewDistance,
    PrePlacementResult
} from "./Placement";
import { PlacementStats } from "./PlacementStats";
import { RenderState } from "./RenderState";
import { SimpleLineCurve, SimplePath } from "./SimplePath";
import { TextCanvasFactory } from "./TextCanvasFactory";
import { TextCanvasRenderer } from "./TextCanvasRenderer";
import { LoadingState, poiIsRenderable, TextElement, TextPickResult } from "./TextElement";
import { TextElementGroup } from "./TextElementGroup";
import { TextElementFilter, TextElementGroupState } from "./TextElementGroupState";
import {
    initializeDefaultOptions,
    TextElementsRendererOptions
} from "./TextElementsRendererOptions";
import { TextElementState } from "./TextElementState";
import { TextElementStateCache } from "./TextElementStateCache";
import { TextElementType } from "./TextElementType";
import { TextStyleCache } from "./TextStyleCache";
import { UpdateStats } from "./UpdateStats";
import { ViewState } from "./ViewState";

const MAX_INITIALIZED_TEXT_ELEMENTS_PER_FRAME = Infinity;

interface RenderParams {
    numRenderedTextElements: number;
    // TODO: HARP-7373. Move to update() method at the end of the frame.
    fadeAnimationRunning: boolean;
    time: number;
}

interface TempParams {
    additionParams: AdditionParameters;
    poiMeasurementParams: MeasurementParameters;
    measurementParams: MeasurementParameters;
    bufferAdditionParams: TextBufferAdditionParameters;
}

enum Pass {
    PersistentLabels,
    NewLabels
}

/**
 * Default distance scale. Will be applied if distanceScale is not defined in the technique.
 * Defines the scale that will be applied to labeled icons (icon and text) in the distance.
 */
export const DEFAULT_TEXT_DISTANCE_SCALE = 0.5;

/**
 * Maximum number of recommended labels. If more labels are encountered, the "overloaded" mode is
 * set, which modifies the behavior of label placement and rendering, trying to keep delivering an
 * interactive performance. The overloaded mode should not be activated if the [[MapView]] is
 * rendering a static image (camera not moving and no animation running).
 */
const OVERLOAD_LABEL_LIMIT = 20000;

/**
 * If "overloaded" is `true`:
 *
 * Default number of labels/POIs updated in a frame. They are rendered only if they fit. If the
 * camera is not moving, it is ignored. See [[TextElementsRenderer.isDynamicFrame]].
 */
const OVERLOAD_UPDATED_LABEL_LIMIT = 100;

/**
 * If "overloaded" is `true`:
 *
 * Maximum time in milliseconds available for placement. If value is <= 0, or if the camera is not
 * moving, it is ignored. See [[TextElementsRenderer.isDynamicFrame]].
 */
const OVERLOAD_UPDATE_TIME_LIMIT = 5;

/**
 * If "overloaded" is `true`:
 *
 * Maximum time in milliseconds available for rendering. If value is <= 0, or if the camera is not
 * moving, it is ignored. See [[TextElementsRenderer.isDynamicFrame]].
 */
const OVERLOAD_PLACE_TIME_LIMIT = 10;

/**
 * Minimum number of pixels per character. Used during estimation if there is enough screen space
 * available to render a text.
 */
const MIN_AVERAGE_CHAR_WIDTH = 5;

const logger = LoggerManager.instance.create("TextElementsRenderer", { level: LogLevel.Log });

// Development flag: Enable debug print.
const PRINT_LABEL_DEBUG_INFO: boolean = false;
const updateStats = PRINT_LABEL_DEBUG_INFO ? new UpdateStats(logger) : undefined;
const placementStats = PRINT_LABEL_DEBUG_INFO ? new PlacementStats(logger) : undefined;

const tempBox = new THREE.Box2();
const tempBoxes: THREE.Box2[] = [];
const tempBox2D = new Math2D.Box();

const tempPosition = new THREE.Vector3();
const tempScreenPosition = new THREE.Vector2();
const tempScreenPoints: THREE.Vector2[] = [];
const tempPoiScreenPosition = new THREE.Vector2();
const tempTextOffset = new THREE.Vector2();

class TileTextElements {
    constructor(readonly tile: Tile, readonly group: TextElementGroup) {}
}

class TextElementLists {
    constructor(readonly lists: TileTextElements[]) {}

    get priority() {
        assert(this.lists.length > 0);
        // All text element lists here have the same priority.
        return this.lists[0].group.priority;
    }
    /**
     * Sum up the number of elements in all lists.
     */
    count(): number {
        let n = 0;
        for (const list of this.lists) {
            n += list.group.elements.length;
        }
        return n;
    }
}

enum InitState {
    Uninitialized,
    Initializing,
    Initialized
}

function checkIfTextElementsChanged(dataSourceTileList: DataSourceTileList[]) {
    let textElementsChanged = false;

    dataSourceTileList.forEach(({ renderedTiles }) => {
        renderedTiles.forEach(tile => {
            if (tile.textElementsChanged) {
                tile.textElementsChanged = false;
                textElementsChanged = true;
            }
        });
    });

    return textElementsChanged;
}

export type ViewUpdateCallback = () => void;

function isPlacementTimeExceeded(startTime: number | undefined): boolean {
    // startTime is set in overload mode.
    if (startTime === undefined || OVERLOAD_PLACE_TIME_LIMIT <= 0) {
        return false;
    }
    const endTime = PerformanceTimer.now();
    const elapsedTime = endTime - startTime;
    if (elapsedTime > OVERLOAD_PLACE_TIME_LIMIT) {
        logger.debug("Placement time limit exceeded.");
        return true;
    }
    return false;
}

/**
 * @hidden
 *
 * Internal class to manage all text rendering.
 */
export class TextElementsRenderer {
    private m_initState: InitState = InitState.Uninitialized;
    private m_initializedTextElementCount = 0;
    private readonly m_options: TextElementsRendererOptions;

    private readonly m_textStyleCache: TextStyleCache;
    private m_textRenderers: TextCanvasRenderer[] = [];

    private m_overlayTextElements?: TextElement[];

    // TODO: Replace this for an array of textures when more fonts are in use.
    private m_debugGlyphTextureCacheMesh?: THREE.Mesh;
    private m_debugGlyphTextureCacheWireMesh?: THREE.LineSegments;

    private m_tmpVector = new THREE.Vector2();
    private m_overloaded: boolean = false;
    private m_cacheInvalidated: boolean = false;
    private m_forceNewLabelsPass: boolean = false;

    private readonly m_textElementStateCache: TextElementStateCache = new TextElementStateCache();

    /**
     * Create the `TextElementsRenderer` which selects which labels should be placed on screen as
     * a preprocessing step, which is not done every frame, and also renders the placed
     * [[TextElement]]s every frame.
     *
     * @param m_viewState State of the view for which this renderer will draw text.
     * @param m_viewCamera Camera used by the view for which this renderer will draw text.
     * @param m_viewUpdateCallback To be called whenever the view needs to be updated.
     * @param m_screenCollisions General 2D screen occlusion management, may be shared between
     *     instances.
     * @param m_screenProjector Projects 3D coordinates into screen space.
     * @param m_textCanvasFactory To create TextCanvas instances.
     * @param m_poiRendererFactory To create PoiRenderer instances.
     * @param m_poiManager To prepare pois for rendering.
     * @param m_fontCatalogLoader To load font catalogs.
     * @param m_theme Theme defining  text styles.
     * @param options Configuration options for the text renderer. See
     * [[TextElementsRendererOptions]].
     */
    constructor(
        private m_viewState: ViewState,
        private m_viewCamera: THREE.Camera,
        private m_viewUpdateCallback: ViewUpdateCallback,
        private m_screenCollisions: ScreenCollisions,
        private m_screenProjector: ScreenProjector,
        private m_textCanvasFactory: TextCanvasFactory,
        private m_poiManager: PoiManager,
        private m_poiRendererFactory: PoiRendererFactory,
        private m_fontCatalogLoader: FontCatalogLoader,
        private m_theme: Theme,
        options: TextElementsRendererOptions
    ) {
        this.m_textStyleCache = new TextStyleCache(this.m_theme);

        this.m_options = { ...options };
        initializeDefaultOptions(this.m_options);

        this.m_textCanvasFactory.setGlyphCountLimits(
            this.m_options.minNumGlyphs!,
            this.m_options.maxNumGlyphs!
        );
    }

    /**
     * Disable all fading animations (for debugging and performance measurement). Defaults to
     * `false`.
     */
    set disableFading(disable: boolean) {
        this.m_options.disableFading = disable;
    }

    get disableFading(): boolean {
        return this.m_options.disableFading === true;
    }

    get styleCache() {
        return this.m_textStyleCache;
    }

    /**
     * Render the text using the specified camera into the current canvas.
     *
     * @param camera Orthographic camera to use.
     */
    renderText(camera: THREE.OrthographicCamera) {
        if (!this.initialized) {
            return;
        }

        this.updateGlyphDebugMesh();

        for (const textRenderer of this.m_textRenderers) {
            textRenderer.textCanvas.render(camera);
        }
    }

    /**
     * Forces update of text elements in the next call to [[placeText]].
     */
    invalidateCache() {
        this.m_cacheInvalidated = true;
    }

    /**
     * Notify `TextElementsRenderer` that the camera has started a movement.
     */
    movementStarted() {
        // Nothing to do (yet)
    }

    /**
     * Notify `TextElementsRenderer` that the camera has finished its movement.
     */
    movementFinished() {
        this.invalidateCache();
    }

    /**
     * Is `true` if number of [[TextElement]]s in visible tiles is larger than the recommended
     * number `OVERLOAD_LABEL_LIMIT`.
     */
    get overloaded(): boolean {
        return this.m_overloaded;
    }

    /**
     * Places text elements for the current frame.
     * @param dataSourceTileList List of tiles to be rendered for each data source.
     * @param projection The view's projection.
     * @param time Current frame time.
     */
    placeText(dataSourceTileList: DataSourceTileList[], projection: Projection, time: number) {
        const tileTextElementsChanged = checkIfTextElementsChanged(dataSourceTileList);

        const textElementsAvailable = this.hasOverlayText() || tileTextElementsChanged;
        if (!this.initialize(textElementsAvailable)) {
            return;
        }

        const updateTextElements =
            this.m_cacheInvalidated ||
            tileTextElementsChanged ||
            this.m_viewState.renderedTilesChanged;

        logger.debug(
            `FRAME: ${this.m_viewState.frameNumber}, ZOOM LEVEL: ${this.m_viewState.zoomLevel}`
        );

        const clearVisitedGroups = updateTextElements;
        const anyTextGroupEvicted = this.m_textElementStateCache.update(
            time,
            clearVisitedGroups,
            this.m_options.disableFading!
        );

        if (updateTextElements) {
            this.updateTextElements(dataSourceTileList, projection);
        }

        this.reset();
        this.prepopulateScreenWithBlockingElements(dataSourceTileList);

        // New text elements must be placed either if text elements were updated in this frame
        // or if any text element group was evicted. The second case happens when the group is not
        // visited anymore and all it's elements just became invisible, which means there's newly
        // available screen space where new text elements could be placed. A common scenario where
        // this happens is zooming in/out: text groups from the old level may still be fading out
        // after all groups in the new level were updated.
        const placeNewTextElements = updateTextElements || anyTextGroupEvicted;
        this.placeTextElements(time, placeNewTextElements);
        this.placeOverlayTextElements();
        this.updateTextRenderers();
    }

    /**
     * Adds new overlay text elements to this `MapView`.
     *
     * @param textElements Array of [[TextElement]] to be added.
     */
    addOverlayText(textElements: TextElement[]): void {
        if (textElements.length === 0) {
            return;
        }
        this.m_overlayTextElements =
            this.m_overlayTextElements === undefined
                ? textElements.slice()
                : this.m_overlayTextElements.concat(textElements);
    }

    /**
     * Adds new overlay text elements to this `MapView`.
     *
     * @param textElements Array of [[TextElement]] to be added.
     */
    clearOverlayText(): void {
        this.m_overlayTextElements = [];
    }

    /**
     * @returns Whether there's overlay text to be rendered.
     */
    hasOverlayText(): boolean {
        return this.m_overlayTextElements !== undefined && this.m_overlayTextElements.length > 0;
    }

    get overlayText(): TextElement[] | undefined {
        return this.m_overlayTextElements;
    }

    /**
     * Fill the picking results for the pixel with the given screen coordinate. If multiple
     * [[TextElement]]s are found, the order of the results is unspecified.
     *
     * Note: [[TextElement]]s with identical `featureId` or identical `userData` will only appear
     * once in the list `pickResults`.
     *
     * @param screenPosition Screen coordinate of picking position.
     * @param pickResults Array filled with pick results.
     */
    pickTextElements(screenPosition: THREE.Vector2, pickResults: PickResult[]) {
        const pickHandler = (pickData: any | undefined, pickObjectType: PickObjectType) => {
            const textElement = pickData as TextElement;

            if (textElement === undefined) {
                return;
            }

            let isDuplicate = false;

            if (textElement.featureId !== undefined) {
                isDuplicate = pickResults.some(pickResult => {
                    return (
                        pickResult !== undefined &&
                        pickObjectType === pickResult.type &&
                        ((pickResult.featureId !== undefined &&
                            pickResult.featureId === textElement.featureId) ||
                            (pickResult.userData !== undefined &&
                                pickResult.userData === textElement.userData))
                    );
                });

                if (!isDuplicate) {
                    const pickResult: TextPickResult = {
                        type: pickObjectType,
                        point: screenPosition,
                        distance: 0,
                        featureId: textElement.featureId,
                        userData: textElement.userData,
                        text: textElement.text
                    };

                    pickResults.push(pickResult);
                }
            }
        };

        for (const textRenderer of this.m_textRenderers) {
            textRenderer.textCanvas.pickText(screenPosition, (pickData: any | undefined) => {
                pickHandler(pickData, PickObjectType.Text);
            });
            textRenderer.poiRenderer.pickTextElements(
                screenPosition,
                (pickData: any | undefined) => {
                    pickHandler(pickData, PickObjectType.Icon);
                }
            );
        }
    }

    /**
     * `true` if any resource used by any `FontCatalog` is still loading.
     */
    get loading(): boolean {
        let isLoading = this.m_fontCatalogLoader.loading;
        for (const textRenderer of this.m_textRenderers) {
            isLoading = isLoading || textRenderer.textCanvas.fontCatalog.isLoading;
        }
        return isLoading;
    }

    /**
     * Reset the current text render states of all visible tiles. All [[TextElement]]s will fade in
     * after that as if they have just been added.
     */
    clearRenderStates() {
        this.m_textElementStateCache.clear();
    }

    /**
     * Return memory used by all objects managed by `TextElementsRenderer`.
     *
     * @returns `MemoryUsage` Heap and GPU memory used by this `TextElementsRenderer`.
     */
    getMemoryUsage(): MapViewUtils.MemoryUsage {
        const memoryUsage = {
            heapSize: 0,
            gpuSize: 0
        };

        for (const renderer of this.m_textRenderers) {
            renderer.textCanvas.getMemoryUsage(memoryUsage);
            renderer.poiRenderer.getMemoryUsage(memoryUsage);
        }

        return memoryUsage;
    }

    get initialized(): boolean {
        return this.m_initState === InitState.Initialized;
    }

    get initializing(): boolean {
        return this.m_initState === InitState.Initializing;
    }

    /**
     * Initializes the text renderer once there's any text element available for rendering.
     * @param textElementsAvailable Indicates whether there's any text element to be rendered.
     * @returns Whether the text renderer is initialized.
     */
    private initialize(textElementsAvailable: boolean): boolean {
        if (this.m_initState === InitState.Uninitialized && textElementsAvailable) {
            this.m_initState = InitState.Initializing;
            this.invalidateCache(); // Force cache update after initialization.
            this.initializeDefaultAssets();
            this.initializeTextCanvases().then(() => {
                this.m_initState = InitState.Initialized;
            });
        }
        return this.m_initState === InitState.Initialized;
    }

    /**
     * Reset internal state at the beginning of a frame.
     */
    private reset() {
        this.m_screenCollisions.reset();
        for (const textRenderer of this.m_textRenderers) {
            textRenderer.textCanvas.clear();
            textRenderer.poiRenderer.reset();
        }
        this.m_initializedTextElementCount = 0;
    }

    /**
     * Update state at the end of a frame.
     */
    private updateTextRenderers() {
        for (const textRenderer of this.m_textRenderers) {
            textRenderer.poiRenderer.update();
        }
    }

    /**
     * Fills the screen with lines projected from world space, see [[Tile.blockingElements]].
     * @note These boxes have highest priority, so will block all other labels.
     * @param dataSourceTileList List of tiles to be rendered for each data source.
     */
    private prepopulateScreenWithBlockingElements(dataSourceTileList: DataSourceTileList[]) {
        const boxes: IBox[] = [];
        dataSourceTileList.forEach(renderListEntry => {
            const startLinePointProj = new THREE.Vector3();
            const endLinePointProj = new THREE.Vector3();
            for (const tile of renderListEntry.renderedTiles.values()) {
                for (const pathBlockingElement of tile.blockingElements) {
                    if (pathBlockingElement.points.length < 2) {
                        continue;
                    }
                    this.m_screenProjector.project3(
                        pathBlockingElement.points[0],
                        startLinePointProj
                    );
                    for (let i = 1; i < pathBlockingElement.points.length; i++) {
                        this.m_screenProjector.project3(
                            pathBlockingElement.points[i],
                            endLinePointProj
                        );
                        const line = pathBlockingElement.screenSpaceLines[i - 1];
                        line.start.copy(startLinePointProj);
                        line.end.copy(endLinePointProj);
                        const lineWithBound: LineWithBound = {
                            minX: Math.min(startLinePointProj.x, endLinePointProj.x),
                            maxX: Math.max(startLinePointProj.x, endLinePointProj.x),
                            minY: Math.min(startLinePointProj.y, endLinePointProj.y),
                            maxY: Math.max(startLinePointProj.y, endLinePointProj.y),
                            type: "line",
                            line
                        };
                        boxes.push(lineWithBound);
                        startLinePointProj.copy(endLinePointProj);
                    }
                }
            }
        });
        this.m_screenCollisions.allocateIBoxes(boxes);
    }

    /**
     * @returns True if whole group was processed for placement,
     * false otherwise (e.g. placement limit reached).
     */
    private placeTextElementGroup(
        groupState: TextElementGroupState,
        renderParams: RenderParams,
        maxNumPlacedLabels: number,
        pass: Pass
    ): boolean {
        if (this.m_textRenderers.length === 0) {
            logger.warn("No text renderers initialized.");
            return false;
        }

        const shieldGroups: number[][] = [];

        const temp: TempParams = {
            additionParams: {},
            poiMeasurementParams: {},
            measurementParams: {},
            bufferAdditionParams: {}
        };
        const hiddenKinds = this.m_viewState.hiddenGeometryKinds;

        for (const textElementState of groupState.textElementStates) {
            if (pass === Pass.PersistentLabels) {
                if (placementStats) {
                    ++placementStats.total;
                }
            }
            if (
                maxNumPlacedLabels >= 0 &&
                renderParams.numRenderedTextElements >= maxNumPlacedLabels
            ) {
                logger.debug("Placement label limit exceeded.");
                return false;
            }

            // Skip all labels that are not initialized (didn't pass early placement tests)
            // or don't belong to this pass.
            if (!textElementState.initialized) {
                if (placementStats) {
                    ++placementStats.uninitialized;
                }
                continue;
            }
            if (textElementState.viewDistance === undefined) {
                if (placementStats) {
                    ++placementStats.tooFar;
                }
                continue;
            }

            const elementVisible = textElementState.visible;
            if (
                (pass === Pass.PersistentLabels && !elementVisible) ||
                (pass === Pass.NewLabels && elementVisible)
            ) {
                continue;
            }

            const textElement = textElementState.element;

            // Get the TextElementStyle.
            const textElementStyle = this.m_textStyleCache.getTextElementStyle(textElement.style);
            const textCanvas = textElementStyle.textCanvas;
            const poiRenderer = textElementStyle.poiRenderer;
            if (textCanvas === undefined || poiRenderer === undefined) {
                logger.warn("Text canvas or poi renderer not ready.");
                continue;
            }

            // TODO: HARP-7648. Discard hidden kinds sooner, before placement.
            // Check if the label should be hidden.
            if (
                hiddenKinds !== undefined &&
                textElement.kind !== undefined &&
                hiddenKinds.hasOrIntersects(textElement.kind)
            ) {
                continue;
            }

            const elementType = textElement.type;
            const isPathLabel = elementType === TextElementType.PathLabel;

            // For paths, check if the label may fit.
            if (isPathLabel) {
                // TODO: HARP-7648. checkForSmallLabels takes a large part of text placement time.
                // Try to make it faster or execute cheaper rejection tests before.
                if (!this.checkForSmallLabels(textElement, tempScreenPoints)) {
                    if (placementStats) {
                        placementStats.numNotVisible++;
                    }
                    if (textElement.dbgPathTooSmall === true) {
                        if (placementStats) {
                            placementStats.numPathTooSmall++;
                        }
                    }
                    textElementState.reset();
                    continue;
                }
            }

            // Trigger the glyph load if needed.
            if (textElement.loadingState === undefined) {
                textElement.loadingState = LoadingState.Requested;

                if (textElement.renderStyle === undefined) {
                    textElement.renderStyle = new TextRenderStyle({
                        ...textElementStyle.renderParams,
                        ...textElement.renderParams
                    });
                }
                if (textElement.layoutStyle === undefined) {
                    textElement.layoutStyle = new TextLayoutStyle({
                        ...textElementStyle.layoutParams,
                        ...textElement.layoutParams
                    });
                }

                if (textElement.text === "") {
                    textElement.loadingState = LoadingState.Loaded;
                } else {
                    textCanvas.fontCatalog
                        .loadCharset(textElement.text, textElement.renderStyle)
                        .then(() => {
                            textElement.loadingState = LoadingState.Loaded;
                            // Ensure that text elements that were loading glyphs get a chance
                            // to be rendered if there's no text element updates in the next frames.
                            this.m_forceNewLabelsPass = true;
                            this.m_viewUpdateCallback();
                        });
                }
            }
            if (textElement.loadingState === LoadingState.Loaded) {
                if (this.m_initializedTextElementCount < MAX_INITIALIZED_TEXT_ELEMENTS_PER_FRAME) {
                    textCanvas.textRenderStyle = textElement.renderStyle!;
                    textCanvas.textLayoutStyle = textElement.layoutStyle!;
                    textElement.glyphCaseArray = [];
                    textElement.glyphs = textCanvas.fontCatalog.getGlyphs(
                        textElement.text,
                        textCanvas.textRenderStyle,
                        textElement.glyphCaseArray
                    );
                    if (!isPathLabel) {
                        textElement.bounds = new THREE.Box2();
                        temp.poiMeasurementParams.letterCaseArray = textElement.glyphCaseArray!;
                        textCanvas.measureText(
                            textElement.glyphs!,
                            textElement.bounds,
                            temp.poiMeasurementParams
                        );
                    }
                    textElement.loadingState = LoadingState.Initialized;
                    ++this.m_initializedTextElementCount;
                }
            }
            if (textElement.loadingState !== LoadingState.Initialized) {
                continue;
            }

            const layer = textCanvas.getLayer(textElement.renderOrder || DEFAULT_TEXT_CANVAS_LAYER);

            // Move onto the next TextElement if we cannot continue adding glyphs to this layer.
            if (layer !== undefined) {
                if (layer.storage.drawCount + textElement.glyphs!.length > layer.storage.capacity) {
                    if (placementStats) {
                        ++placementStats.numCannotAdd;
                    }
                    logger.warn("layer glyph storage capacity exceeded.");
                    continue;
                }
            }

            // Set the current style for the canvas.
            textCanvas.textRenderStyle = textElement.renderStyle!;
            textCanvas.textLayoutStyle = textElement.layoutStyle!;

            switch (elementType) {
                case TextElementType.PoiLabel:
                    this.addPoiLabel(
                        textElementState,
                        groupState,
                        poiRenderer,
                        textCanvas,
                        renderParams,
                        temp
                    );
                    break;
                case TextElementType.LineMarker:
                    this.addLineMarkerLabel(
                        textElementState,
                        groupState,
                        poiRenderer,
                        shieldGroups,
                        textCanvas,
                        renderParams,
                        temp
                    );
                    break;
                case TextElementType.PathLabel:
                    this.addPathLabel(
                        textElementState,
                        groupState,
                        tempScreenPoints,
                        textCanvas,
                        renderParams,
                        temp
                    );
            }
        }
        return true;
    }

    private initializeDefaultAssets(): void {
        const defaultFontCatalogName = this.m_fontCatalogLoader.initialize(
            this.m_options.fontCatalog!
        );
        this.m_textStyleCache.initializeDefaultTextElementStyle(defaultFontCatalogName);
    }

    private async initializeTextCanvases(): Promise<void> {
        const catalogCallback = (name: string, catalog: FontCatalog) => {
            const loadedTextCanvas = this.m_textCanvasFactory.createTextCanvas(catalog);

            this.m_textRenderers.push({
                fontCatalog: name,
                textCanvas: loadedTextCanvas,
                poiRenderer: this.m_poiRendererFactory.createPoiRenderer(loadedTextCanvas)
            });
        };

        return this.m_fontCatalogLoader.loadCatalogs(catalogCallback).then(() => {
            // Find the default TextCanvas and PoiRenderer.
            let defaultTextCanvas: TextCanvas | undefined;
            this.m_textRenderers.forEach(textRenderer => {
                if (defaultTextCanvas === undefined) {
                    defaultTextCanvas = textRenderer.textCanvas;
                }
            });
            const defaultPoiRenderer = this.m_poiRendererFactory.createPoiRenderer(
                defaultTextCanvas!
            );

            this.m_textStyleCache.initializeTextElementStyles(
                defaultPoiRenderer,
                defaultTextCanvas!,
                this.m_textRenderers
            );

            this.m_viewUpdateCallback();
        });
    }

    private updateGlyphDebugMesh() {
        const debugGlyphs = debugContext.getValue("DEBUG_GLYPHS");
        if (debugGlyphs === undefined) {
            return;
        }

        if (debugGlyphs && this.m_debugGlyphTextureCacheMesh === undefined) {
            this.initializeGlyphDebugMesh();
        }
        assert(this.m_debugGlyphTextureCacheMesh !== undefined);
        assert(this.m_debugGlyphTextureCacheWireMesh !== undefined);

        this.m_debugGlyphTextureCacheMesh!.visible = debugGlyphs;
        this.m_debugGlyphTextureCacheWireMesh!.visible = debugGlyphs;
    }

    private initializeGlyphDebugMesh() {
        const defaultFontCatalog = this.m_textRenderers[0].textCanvas.fontCatalog;

        // Initialize glyph-debugging mesh.
        const planeGeometry = new THREE.PlaneGeometry(
            defaultFontCatalog.textureSize.width / 2.5,
            defaultFontCatalog.textureSize.height / 2.5,
            defaultFontCatalog.textureSize.width / defaultFontCatalog.maxWidth,
            defaultFontCatalog.textureSize.height / defaultFontCatalog.maxHeight
        );
        const material = new THREE.MeshBasicMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: false,
            map: defaultFontCatalog.texture
        });
        this.m_debugGlyphTextureCacheMesh = new THREE.Mesh(planeGeometry, material);
        this.m_debugGlyphTextureCacheMesh.renderOrder = 10000;
        this.m_debugGlyphTextureCacheMesh.visible = false;

        this.m_debugGlyphTextureCacheMesh.name = "glyphDebug";

        const wireframe = new THREE.WireframeGeometry(planeGeometry);
        const wireframeMaterial = new THREE.LineBasicMaterial({
            transparent: true,
            color: 0x999999,
            depthWrite: false,
            depthTest: false
        });
        this.m_debugGlyphTextureCacheWireMesh = new THREE.LineSegments(
            wireframe,
            wireframeMaterial
        );
        this.m_debugGlyphTextureCacheWireMesh.renderOrder = 9999;
        this.m_debugGlyphTextureCacheWireMesh.visible = false;

        this.m_debugGlyphTextureCacheWireMesh.name = "glyphDebug";

        this.m_textRenderers[0].textCanvas
            .getLayer(DEFAULT_TEXT_CANVAS_LAYER)!
            .storage.scene.add(
                this.m_debugGlyphTextureCacheMesh,
                this.m_debugGlyphTextureCacheWireMesh
            );
    }

    /**
     * Visit all visible tiles and add/ their text elements to cache. The update of
     * [[TextElement]]s is a time consuming process, and cannot be done every frame, but should only
     * be done when the camera moved (a lot) of whenever the set of visible tiles change.
     *
     * The actually rendered [[TextElement]]s are stored internally until the next update is done
     * to speed up rendering when no camera movement was detected.
     * @param dataSourceTileList List of tiles to be rendered for each data source.
     * @param projection The view's projection.
     */
    private updateTextElements(dataSourceTileList: DataSourceTileList[], projection: Projection) {
        logger.debug("updateTextElements");

        if (updateStats) {
            updateStats.clear();
        }

        this.m_cacheInvalidated = false;

        this.checkIfOverloaded(dataSourceTileList);

        // Used with tile offset to compute the x coordinate offset for tiles.
        const updateStartTime =
            this.overloaded && this.m_viewState.isDynamic ? PerformanceTimer.now() : undefined;

        // TODO: HARP-7648. Skip all data sources that won't contain text.
        // TODO: HARP-7651. Higher priority labels should be updated before lower priority ones
        // across all data sources.
        // TODO: HARP-7373. Use rendered tiles (tiles currently rendered to cover the view,
        // including fallbacks if necessary) instead of visible tiles (target tiles that might not
        // be decoded yet).
        // Otherwise labels persistent when crossing a zoom level boundary will flicker (fade out
        // and back in) due to the delay in decoding the visible tiles.
        dataSourceTileList.forEach(tileList => {
            this.updateTextElementsFromSource(
                tileList.dataSource,
                tileList.storageLevel,
                Array.from(tileList.renderedTiles.values()),
                projection,
                updateStartTime
            );
        });

        if (updateStats) {
            updateStats.log();
        }
    }

    private updateTextElementsFromSource(
        tileDataSource: DataSource,
        storageLevel: number,
        visibleTiles: Tile[],
        projection: Projection,
        updateStartTime: number | undefined
    ) {
        if (updateStats) {
            updateStats.tiles += visibleTiles.length;
        }
        const sortedTiles = visibleTiles;

        // TODO: HARP-7648. Really needed? Should it be done here or in VisibleTileSet?
        sortedTiles.sort((a: Tile, b: Tile) => {
            return a.tileKey.mortonCode() - b.tileKey.mortonCode();
        });

        // Prepare user text elements.
        for (const tile of sortedTiles) {
            this.prepareTextElementGroup(tile.userTextElements, projection);
        }

        const sortedGroups: TextElementLists[] = [];
        this.createSortedGroupsForSorting(tileDataSource, storageLevel, sortedTiles, sortedGroups);

        let numTextElementsUpdated = 0;

        for (const textElementLists of sortedGroups) {
            this.selectTextElementsToUpdateByDistance(textElementLists, projection);

            // The value of updateStartTime is set if this.overloaded is true.
            if (updateStartTime !== undefined) {
                // If overloaded and all time is used up, exit early.
                if (OVERLOAD_UPDATE_TIME_LIMIT > 0) {
                    const endTime = PerformanceTimer.now();
                    const elapsedTime = endTime - updateStartTime;
                    if (elapsedTime > OVERLOAD_UPDATE_TIME_LIMIT) {
                        logger.debug("Update time limit exceeded.");
                        break;
                    }
                }

                // Try not to update too many elements. They will be checked for visibility each
                // frame.
                numTextElementsUpdated += textElementLists.count();
                if (numTextElementsUpdated >= OVERLOAD_UPDATED_LABEL_LIMIT) {
                    logger.debug("Update label limit exceeded.");
                    break;
                }
            }
        }
    }

    private prepareTextElementGroup(
        textElementGroup: TextElementGroup,
        projection: Projection,
        maxViewDistance?: number
    ) {
        if (textElementGroup.elements.length === 0) {
            return;
        }

        const textElementSelection: TextElementFilter = (
            textElementState: TextElementState
        ): number | undefined => {
            let { result, viewDistance } = checkReadyForPlacement(
                textElementState.element,
                this.m_viewState,
                this.m_viewCamera,
                this.m_poiManager,
                projection.type,
                maxViewDistance
            );

            if (
                result === PrePlacementResult.Ok &&
                !this.m_textElementStateCache.deduplicateElement(textElementState)
            ) {
                result = PrePlacementResult.Duplicate;
                viewDistance = undefined;
            }

            if (updateStats) {
                updateStats.totalLabels++;
                updateStats.results[result]++;
            }
            return viewDistance;
        };

        const [, found] = this.m_textElementStateCache.getOrSet(
            textElementGroup,
            textElementSelection
        );

        if (updateStats) {
            ++updateStats.totalGroups;
            if (!found) {
                ++updateStats.newGroups;
            }
        }
    }

    private createSortedGroupsForSorting(
        tileDataSource: DataSource,
        storageLevel: number,
        sortedTiles: Tile[],
        sortedGroups: TextElementLists[]
    ) {
        if (sortedTiles.length === 0) {
            return;
        }

        const tilesToRender: Tile[] = [];

        for (const tile of sortedTiles) {
            if (tileDataSource.shouldRenderText(storageLevel, tile.tileKey)) {
                tilesToRender.push(tile);
            }
        }

        const groupedPriorityLists: Map<number, TextElementLists> = new Map();

        for (const tile of tilesToRender) {
            for (const group of tile.textElementGroups.groups.values()) {
                if (group.elements.length === 0) {
                    continue;
                }

                const foundGroup = groupedPriorityLists.get(group.priority);
                if (foundGroup === undefined) {
                    groupedPriorityLists.set(
                        group.priority,
                        new TextElementLists([new TileTextElements(tile, group)])
                    );
                } else {
                    foundGroup.lists.push(new TileTextElements(tile, group));
                }
            }
        }

        if (groupedPriorityLists.size === 0) {
            return;
        }

        for (const g of groupedPriorityLists) {
            const lists = g[1];
            sortedGroups.push(lists);
        }

        sortedGroups.sort((a: TextElementLists, b: TextElementLists) => {
            return b.priority - a.priority;
        });

        const printTextInfo = false;

        if (PRINT_LABEL_DEBUG_INFO && printTextInfo) {
            let outString = "";
            for (const textElementLists of sortedGroups) {
                let size = 0;
                for (const tileTextElements of textElementLists.lists) {
                    size += tileTextElements.group.elements.length;
                }
                outString += `priority ${textElementLists.priority} size: ${size}\n`;
            }
            logger.log(outString);
        }
    }

    private selectTextElementsToUpdateByDistance(
        textElementLists: TextElementLists,
        projection: Projection
    ) {
        const farDistanceLimitRatio = Math.max(
            this.m_options.maxDistanceRatioForTextLabels!,
            this.m_options.maxDistanceRatioForPoiLabels!
        );
        const maxViewDistance = getMaxViewDistance(this.m_viewState, farDistanceLimitRatio);

        for (const tileTextElements of textElementLists.lists) {
            this.prepareTextElementGroup(tileTextElements.group, projection, maxViewDistance);
        }
    }

    private placeTextElements(time: number, placeNewTextElements: boolean) {
        const renderParams: RenderParams = {
            numRenderedTextElements: 0,
            fadeAnimationRunning: false,
            time
        };

        const placeStartTime =
            this.overloaded && this.m_viewState.isDynamic ? PerformanceTimer.now() : undefined;

        if (placementStats) {
            placementStats.clear();
        }

        if (this.m_textElementStateCache.size === 0) {
            logger.debug("Text element cache empty.");
            return;
        }

        const placeNew = this.m_forceNewLabelsPass || placeNewTextElements;
        if (this.m_forceNewLabelsPass) {
            if (!placeNewTextElements) {
                logger.debug("Force new label pass");
            }
            this.m_forceNewLabelsPass = false;
        }
        const maxNumPlacedTextElements = this.m_options.maxNumVisibleLabels!;

        // TODO: HARP-7648. Potential performance improvement. Place persistent labels + rejected
        // candidates from previous frame if there's been no placement in this one.
        const groupStates = this.m_textElementStateCache.sortedGroupStates;
        let currentPriority: number = groupStates[0].priority;
        let currentPriorityBegin: number = 0;

        for (let i = 0; i < groupStates.length; ++i) {
            const textElementGroupState = groupStates[i];
            if (placementStats) {
                ++placementStats.totalGroups;
            }

            const newPriority = textElementGroupState.priority;
            if (placeNew && currentPriority !== newPriority) {
                // Place all new labels of the previous priority before placing the persistent
                // labels of this priority.
                this.placeNewTextElements(currentPriorityBegin, i, renderParams);
                if (isPlacementTimeExceeded(placeStartTime)) {
                    break;
                }
                currentPriority = newPriority;
                currentPriorityBegin = i;
            }
            if (
                !this.placeTextElementGroup(
                    textElementGroupState,
                    renderParams,
                    maxNumPlacedTextElements,
                    Pass.PersistentLabels
                )
            ) {
                break;
            }

            if (isPlacementTimeExceeded(placeStartTime)) {
                break;
            }
        }

        if (placeNew) {
            // Place new text elements of the last priority.
            this.placeNewTextElements(currentPriorityBegin, groupStates.length, renderParams);
        }

        if (placementStats) {
            placementStats.numRenderedTextElements = renderParams.numRenderedTextElements;
            placementStats.log();
        }

        if (!this.m_options.disableFading && renderParams.fadeAnimationRunning) {
            this.m_viewUpdateCallback();
        }
    }

    private placeNewTextElements(
        beginGroupIndex: number,
        endGroupIndex: number,
        renderParams: RenderParams
    ) {
        const groupStates = this.m_textElementStateCache.sortedGroupStates;
        for (let i = beginGroupIndex; i < endGroupIndex; ++i) {
            if (
                !this.placeTextElementGroup(
                    groupStates[i],
                    renderParams,
                    this.m_options.maxNumVisibleLabels!,
                    Pass.NewLabels
                )
            ) {
                break;
            }
        }
    }

    private placeOverlayTextElements() {
        if (this.m_overlayTextElements === undefined || this.m_overlayTextElements.length === 0) {
            return;
        }

        const screenSize = this.m_tmpVector.set(
            this.m_screenProjector.width,
            this.m_screenProjector.height
        );
        const screenXOrigin = -screenSize.width / 2.0;
        const screenYOrigin = screenSize.height / 2.0;

        const tempAdditionParams: AdditionParameters = {};
        const tempBufferAdditionParams: TextBufferAdditionParameters = {};

        // Place text elements one by one.
        for (const textElement of this.m_overlayTextElements!) {
            // Get the TextElementStyle.
            const textElementStyle = this.m_textStyleCache.getTextElementStyle(textElement.style);
            const textCanvas = textElementStyle.textCanvas;
            if (textCanvas === undefined) {
                continue;
            }
            const layer = textCanvas.getLayer(textElement.renderOrder || DEFAULT_TEXT_CANVAS_LAYER);

            // Trigger the glyph load if needed.
            if (textElement.loadingState === undefined) {
                textElement.loadingState = LoadingState.Requested;

                if (textElement.renderStyle === undefined) {
                    textElement.renderStyle = new TextRenderStyle({
                        ...textElementStyle.renderParams,
                        ...textElement.renderParams
                    });
                }
                if (textElement.layoutStyle === undefined) {
                    textElement.layoutStyle = new TextLayoutStyle({
                        ...textElementStyle.layoutParams,
                        ...textElement.layoutParams
                    });
                }

                if (textElement.text === "") {
                    textElement.loadingState = LoadingState.Loaded;
                } else {
                    textCanvas.fontCatalog
                        .loadCharset(textElement.text, textElement.renderStyle)
                        .then(() => {
                            textElement.loadingState = LoadingState.Loaded;
                            this.m_viewUpdateCallback();
                        });
                }
            }
            if (textElement.loadingState === LoadingState.Loaded) {
                if (this.m_initializedTextElementCount < MAX_INITIALIZED_TEXT_ELEMENTS_PER_FRAME) {
                    textCanvas.textRenderStyle = textElement.renderStyle!;
                    textCanvas.textLayoutStyle = textElement.layoutStyle!;
                    textElement.glyphCaseArray = [];
                    textElement.glyphs = textCanvas.fontCatalog.getGlyphs(
                        textElement.text,
                        textCanvas.textRenderStyle,
                        textElement.glyphCaseArray
                    );
                    textElement.loadingState = LoadingState.Initialized;
                    ++this.m_initializedTextElementCount;
                }
            }
            if (textElement.loadingState !== LoadingState.Initialized) {
                continue;
            }

            // Move onto the next TextElement if we cannot continue adding glyphs to this layer.
            if (layer !== undefined) {
                if (layer.storage.drawCount + textElement.glyphs!.length > layer.storage.capacity) {
                    continue;
                }
            }

            // Set the current style for the canvas.
            textCanvas.textRenderStyle = textElement.renderStyle!;
            textCanvas.textLayoutStyle = textElement.layoutStyle!;

            // Place text.
            let textPath;
            if (!(textElement.type === TextElementType.PathLabel)) {
                // Adjust the label positioning.
                tempScreenPosition.x = screenXOrigin + textElement.position.x * screenSize.width;
                tempScreenPosition.y = screenYOrigin - textElement.position.y * screenSize.height;
                if (textElement.xOffset !== undefined) {
                    tempScreenPosition.x += textElement.xOffset;
                }
                if (textElement.yOffset !== undefined) {
                    tempScreenPosition.y -= textElement.yOffset;
                }

                tempPosition.x = tempScreenPosition.x;
                tempPosition.y = tempScreenPosition.y;
                tempPosition.z = 0.0;

                tempBufferAdditionParams.position = tempPosition;
                tempAdditionParams.layer = textElement.renderOrder;
                tempAdditionParams.letterCaseArray = textElement.glyphCaseArray;
                tempAdditionParams.pickingData = textElement.userData ? textElement : undefined;
                textCanvas.addText(textElement.glyphs!, tempPosition, tempAdditionParams);
            } else {
                // Adjust the label positioning.
                tempScreenPosition.x = screenXOrigin;
                tempScreenPosition.y = screenYOrigin;
                if (textElement.xOffset !== undefined) {
                    tempScreenPosition.x += textElement.xOffset;
                }
                if (textElement.yOffset !== undefined) {
                    tempScreenPosition.y -= textElement.yOffset;
                }

                // Get the screen points that define the label's segments and create a path with
                // them.
                // TODO: HARP-7648. Optimize array allocations.
                const screenPoints: THREE.Vector2[] = [];
                for (const pt of textElement.path!) {
                    const pX = tempScreenPosition.x + pt.x * screenSize.width;
                    const pY = tempScreenPosition.y - pt.y * screenSize.height;
                    screenPoints.push(new THREE.Vector2(pX, pY));
                }
                textPath = new SimplePath();
                for (let i = 0; i < screenPoints.length - 1; ++i) {
                    textPath.add(new THREE.LineCurve(screenPoints[i], screenPoints[i + 1]));
                }

                tempAdditionParams.path = textPath;
                tempAdditionParams.pathOverflow = true;
                tempAdditionParams.layer = textElement.renderOrder;
                tempAdditionParams.letterCaseArray = textElement.glyphCaseArray;
                tempAdditionParams.pickingData = textElement.userData ? textElement : undefined;
                textCanvas.addText(textElement.glyphs!, tempPosition, tempAdditionParams);
            }
        }
    }

    private getDistanceScalingFactor(
        label: TextElement,
        distance: number,
        lookAtDistance: number
    ): number {
        // Distance scale is based on relation between camera focus point distance and
        // the actual label distance. For labels close to camera look at point the scale
        // remains unchanged, the farther is label from that point the smaller size it is
        // rendered in screen space. This method is unaffected by near and far clipping planes
        // distances, but may be improved by taking FOV into equation or customizing the
        // focus point screen position based on horizont, actual ground, tilt ets.
        let factor = lookAtDistance / distance;
        // The label.distanceScale property defines the influence ratio at which
        // distance affects the final scaling of label.
        factor = 1.0 + (factor - 1.0) * label.distanceScale;
        // Preserve the constraints
        factor = Math.max(factor, this.m_options.labelDistanceScaleMin!);
        factor = Math.min(factor, this.m_options.labelDistanceScaleMax!);
        return factor;
    }

    private getDistanceFadingFactor(
        label: TextElement,
        state: TextElementState,
        maxVisibilityDist: number
    ): number {
        let distanceFadeValue = 1.0;
        const textDistance = state.viewDistance;

        if (textDistance !== undefined && label.fadeFar !== undefined && label.fadeFar > 0.0) {
            const fadeNear = label.fadeNear === undefined ? 0.0 : label.fadeNear;
            const fadeFar = label.fadeFar;
            if (fadeFar > fadeNear) {
                distanceFadeValue =
                    1.0 -
                    THREE.Math.clamp(
                        (textDistance / maxVisibilityDist - fadeNear) / (fadeFar - fadeNear),
                        0.0,
                        1.0
                    );
            }
        }
        return distanceFadeValue;
    }

    private addPointLabel(
        labelState: TextElementState,
        groupState: TextElementGroupState,
        position: THREE.Vector3,
        screenPosition: THREE.Vector2,
        poiRenderer: PoiRenderer,
        textCanvas: TextCanvas,
        renderParams: RenderParams,
        temp: TempParams,
        iconIndex?: number
    ): boolean {
        const pointLabel: TextElement = labelState.element;
        const textRenderState: RenderState | undefined = labelState.textRenderState;

        assert(iconIndex === undefined || labelState.iconRenderStates !== undefined);
        const iconRenderState: RenderState =
            iconIndex !== undefined
                ? labelState.iconRenderStates![iconIndex]
                : labelState.iconRenderState!;
        assert(iconRenderState !== undefined);

        const poiTextMaxDistance = getMaxViewDistance(
            this.m_viewState,
            this.m_options.maxDistanceRatioForPoiLabels!
        );
        const hasText = textRenderState !== undefined && pointLabel.text !== "";

        // Find the label's original position.
        tempScreenPosition.x = tempPoiScreenPosition.x = screenPosition.x;
        tempScreenPosition.y = tempPoiScreenPosition.y = screenPosition.y;

        // Scale the text depending on the label's distance to the camera.
        let textScale = 1.0;
        let distanceScaleFactor = 1.0;
        const textDistance = this.m_viewState.worldCenter.distanceTo(position);
        if (textDistance !== undefined) {
            if (
                pointLabel.fadeFar !== undefined &&
                (pointLabel.fadeFar <= 0.0 ||
                    pointLabel.fadeFar * this.m_viewState.maxVisibilityDist < textDistance)
            ) {
                // The label is farther away than fadeFar value, which means it is totally
                // transparent.
                if (placementStats) {
                    ++placementStats.tooFar;
                }
                return false;
            }
            labelState.setViewDistance(textDistance);

            distanceScaleFactor = this.getDistanceScalingFactor(
                pointLabel,
                textDistance,
                this.m_viewState.lookAtDistance
            );
            textScale *= distanceScaleFactor;
        }
        const distanceFadeFactor = this.getDistanceFadingFactor(
            pointLabel,
            labelState,
            this.m_viewState.maxVisibilityDist
        );

        // Check if there is need to check for screen space for the label's icon.
        const poiInfo = pointLabel.poiInfo;
        let iconSpaceAvailable = true;

        // Check if icon should be rendered at this zoomLevel
        let renderIcon =
            poiInfo !== undefined &&
            MathUtils.isClamped(
                this.m_viewState.zoomLevel,
                poiInfo.iconMinZoomLevel,
                poiInfo.iconMaxZoomLevel
            ) &&
            poiInfo!.isValid !== false;

        const iconReady =
            renderIcon && poiRenderer.prepareRender(pointLabel, this.m_viewState.zoomLevel);

        if (iconReady) {
            const iconIsVisible =
                poiRenderer.computeIconScreenBox(
                    poiInfo!,
                    tempPoiScreenPosition,
                    distanceScaleFactor,
                    this.m_viewState.zoomLevel,
                    tempBox2D
                ) && this.m_screenCollisions.isVisible(tempBox2D);

            // If the icon is prepared and valid, but just not visible, try again next time.
            if (!iconIsVisible) {
                // Forced making it un-current.
                iconRenderState.lastFrameNumber = -1;

                if (placementStats) {
                    ++placementStats.numNotVisible;
                }
                return false;
            }

            if (groupState.visited) {
                iconSpaceAvailable = !this.m_screenCollisions.isAllocated(tempBox2D);

                // Reserve screen space if necessary, return false if failed:
                if (
                    // Check if free screen space is available:
                    !iconSpaceAvailable
                ) {
                    if (!iconRenderState.isVisible()) {
                        if (placementStats) {
                            ++placementStats.numNotVisible;
                        }
                        return false;
                    } else if (!(poiInfo!.mayOverlap === true) && !iconRenderState.isFadingOut()) {
                        iconRenderState.startFadeOut(
                            this.m_viewState.frameNumber,
                            renderParams.time
                        );
                        if (hasText && textRenderState!.isVisible()) {
                            textRenderState!.startFadeOut(
                                this.m_viewState.frameNumber,
                                renderParams.time
                            );
                        }
                    }
                } else {
                    if (
                        iconRenderState.lastFrameNumber < this.m_viewState.frameNumber - 1 ||
                        iconRenderState.isFadingOut() ||
                        iconRenderState.isFadedOut()
                    ) {
                        iconRenderState.startFadeIn(
                            this.m_viewState.frameNumber,
                            renderParams.time
                        );
                    }
                }
            } else if (iconRenderState.isVisible()) {
                iconRenderState.startFadeOut(this.m_viewState.frameNumber, renderParams.time);
                iconRenderState.lastFrameNumber = this.m_viewState.frameNumber;
            }
        } else if (renderIcon && poiInfo!.isValid !== false) {
            // Ensure that text elements still loading icons get a chance to be rendered if
            // there's no text element updates in the next frames.
            this.m_forceNewLabelsPass = true;
        }

        // Check if label should be rendered at this zoomLevel
        const renderText =
            hasText &&
            (poiInfo === undefined ||
                this.m_viewState.zoomLevel === undefined ||
                MathUtils.isClamped(
                    this.m_viewState.zoomLevel,
                    poiInfo.iconMinZoomLevel,
                    poiInfo.iconMaxZoomLevel
                ));

        // Check if we should render the label's text.
        const doRenderText =
            // Render if between min/max zoom level
            renderText &&
            // Do not render if the distance is too great and distance shouldn't be ignored.
            (pointLabel.ignoreDistance === true ||
                labelState.viewDistance === undefined ||
                labelState.viewDistance < poiTextMaxDistance) &&
            // Do not render text if POI cannot be rendered and is not optional.
            (poiInfo === undefined || poiInfo.isValid === true || poiInfo.iconIsOptional !== false);

        // Render the label's text...
        // textRenderState is always defined at this point.
        if (doRenderText) {
            tempScreenPosition.add(computePointTextOffset(pointLabel, tempTextOffset));

            // Adjust the label positioning to match its bounding box.
            tempPosition.x = tempScreenPosition.x;
            tempPosition.y = tempScreenPosition.y;
            tempPosition.z = labelState.renderDistance;

            tempBox2D.x = tempScreenPosition.x + pointLabel.bounds!.min.x * textScale;
            tempBox2D.y = tempScreenPosition.y + pointLabel.bounds!.min.y * textScale;
            tempBox2D.w = (pointLabel.bounds!.max.x - pointLabel.bounds!.min.x) * textScale;
            tempBox2D.h = (pointLabel.bounds!.max.y - pointLabel.bounds!.min.y) * textScale;

            // TODO: Make the margin configurable
            tempBox2D.x -= 4 * textScale;
            tempBox2D.y -= 2 * textScale;
            tempBox2D.w += 8 * textScale;
            tempBox2D.h += 4 * textScale;

            // Check the text visibility.
            if (!this.m_screenCollisions.isVisible(tempBox2D)) {
                if (placementStats) {
                    placementStats.numPoiTextsInvisible++;
                }
                labelState.reset();
                return false;
            }

            const textIsOptional: boolean =
                pointLabel.poiInfo !== undefined && pointLabel.poiInfo.textIsOptional === true;

            const textIsFadingIn = textRenderState!.isFadingIn();
            const textIsFadingOut = textRenderState!.isFadingOut();
            const textSpaceAvailable = !this.m_screenCollisions.isAllocated(tempBox2D);
            const textVisible =
                groupState.visited &&
                (pointLabel.textMayOverlap ||
                    textSpaceAvailable ||
                    textIsFadingIn ||
                    textIsFadingOut);

            if (textVisible) {
                // Compute the TextBufferObject when we know we're gonna render this label.
                if (pointLabel.textBufferObject === undefined) {
                    pointLabel.textBufferObject = textCanvas.createTextBufferObject(
                        pointLabel.glyphs!
                    );
                }

                // Allocate collision info if needed.
                if (!textIsFadingOut && pointLabel.textReservesSpace) {
                    this.m_screenCollisions.allocate(tempBox2D);
                }

                // Do not actually render (just allocate space) if camera is moving and
                // renderTextDuringMovements is not true.
                if (
                    (textIsFadingIn ||
                        textIsFadingOut ||
                        !this.m_viewState.cameraIsMoving ||
                        poiInfo === undefined ||
                        poiInfo.renderTextDuringMovements === true) &&
                    !iconRenderState.isFadedOut()
                ) {
                    let textFading = false;
                    if (
                        !textRenderState!.isFadingOut() &&
                        textSpaceAvailable &&
                        iconSpaceAvailable
                    ) {
                        textFading = textRenderState!.checkStartFadeIn(
                            this.m_viewState.frameNumber,
                            renderParams.time,
                            true
                        );
                    } else {
                        textFading = textRenderState!.isFading();
                    }

                    renderParams.fadeAnimationRunning =
                        renderParams.fadeAnimationRunning || textIsFadingOut || textFading;

                    const opacity = textRenderState!.opacity;
                    const backgroundIsVisible =
                        pointLabel.renderStyle!.backgroundOpacity > 0 &&
                        textCanvas.textRenderStyle.fontSize.backgroundSize > 0;

                    temp.bufferAdditionParams.layer = pointLabel.renderOrder;
                    temp.bufferAdditionParams.position = tempPosition;
                    temp.bufferAdditionParams.scale = textScale;
                    temp.bufferAdditionParams.opacity =
                        opacity * distanceFadeFactor * pointLabel.renderStyle!.opacity;
                    temp.bufferAdditionParams.backgroundOpacity = backgroundIsVisible
                        ? temp.bufferAdditionParams.opacity *
                          pointLabel.renderStyle!.backgroundOpacity
                        : 0.0;
                    temp.bufferAdditionParams.pickingData = pointLabel.userData
                        ? pointLabel
                        : undefined;
                    textCanvas.addTextBufferObject(
                        pointLabel.textBufferObject!,
                        temp.bufferAdditionParams
                    );
                }
                if (placementStats) {
                    placementStats.numRenderedPoiTexts++;
                }
            } else if (!renderIcon || !textIsOptional) {
                // If the text is not visible nor optional, we won't render the icon neither.

                renderIcon = false;
                if (pointLabel.poiInfo === undefined || iconRenderState.isVisible()) {
                    if (pointLabel.poiInfo !== undefined) {
                        iconRenderState.startFadeOut(
                            this.m_viewState.frameNumber,
                            renderParams.time
                        );
                    }
                    if (textRenderState!.isVisible()) {
                        const iconStartedFadeOut = textRenderState!.checkStartFadeOut(
                            this.m_viewState.frameNumber,
                            renderParams.time
                        );
                        renderParams.fadeAnimationRunning =
                            renderParams.fadeAnimationRunning || iconStartedFadeOut;
                    }
                } else {
                    if (placementStats) {
                        placementStats.numPoiTextsInvisible++;
                    }
                    return false;
                }
            }
            // If the label is currently visible, fade it out.
            else if (textRenderState!.isVisible()) {
                const iconStartedFadeOut = textRenderState!.checkStartFadeOut(
                    this.m_viewState.frameNumber,
                    renderParams.time
                );
                renderParams.fadeAnimationRunning =
                    renderParams.fadeAnimationRunning || iconStartedFadeOut;
            }
        }
        // ... and render the icon (if any).
        if (renderIcon && poiIsRenderable(poiInfo!)) {
            const iconStartedFadeIn = iconRenderState.checkStartFadeIn(
                this.m_viewState.frameNumber,
                renderParams.time
            );
            renderParams.fadeAnimationRunning =
                renderParams.fadeAnimationRunning || iconStartedFadeIn;

            poiRenderer.renderPoi(
                poiInfo!,
                tempPoiScreenPosition,
                this.m_screenCollisions,
                labelState.renderDistance,
                distanceScaleFactor,
                poiInfo!.reserveSpace !== false,
                iconRenderState.opacity * distanceFadeFactor,
                this.m_viewState.zoomLevel
            );

            iconRenderState.lastFrameNumber = this.m_viewState.frameNumber;

            if (placementStats) {
                placementStats.numRenderedPoiIcons++;
            }
        }
        renderParams.numRenderedTextElements++;
        return true;
    }

    private addPoiLabel(
        labelState: TextElementState,
        groupState: TextElementGroupState,
        poiRenderer: PoiRenderer,
        textCanvas: TextCanvas,
        renderParams: RenderParams,
        temp: TempParams
    ): boolean {
        const poiLabel = labelState.element;
        const worldPosition = poiLabel.points as THREE.Vector3;

        // Only process labels frustum-clipped labels
        if (this.m_screenProjector.project(worldPosition, tempScreenPosition) === undefined) {
            return false;
        }
        // Add this POI as a point label.
        return this.addPointLabel(
            labelState,
            groupState,
            worldPosition,
            tempScreenPosition,
            poiRenderer,
            textCanvas,
            renderParams,
            temp
        );
    }

    private addLineMarkerLabel(
        labelState: TextElementState,
        groupState: TextElementGroupState,
        poiRenderer: PoiRenderer,
        shieldGroups: number[][],
        textCanvas: TextCanvas,
        renderParams: RenderParams,
        temp: TempParams
    ): void {
        const lineMarkerLabel = labelState.element;
        const path = lineMarkerLabel.points as THREE.Vector3[];

        // Early exit if the line marker doesn't have the necessary data.
        const poiInfo = lineMarkerLabel.poiInfo!;
        if (
            path.length === 0 ||
            !poiRenderer.prepareRender(lineMarkerLabel, this.m_viewState.zoomLevel)
        ) {
            return;
        }

        // Initialize the shield group for this lineMarker.
        let shieldGroup: number[] | undefined;
        if (poiInfo.shieldGroupIndex !== undefined) {
            shieldGroup = shieldGroups[poiInfo.shieldGroupIndex];
            if (shieldGroup === undefined) {
                shieldGroup = [];
                shieldGroups[poiInfo.shieldGroupIndex] = shieldGroup;
            }
        }

        const lineTechnique = poiInfo.technique as LineMarkerTechnique;
        const minDistanceSqr =
            lineTechnique.minDistance !== undefined
                ? lineTechnique.minDistance * lineTechnique.minDistance
                : 0;

        // Process markers (with shield groups).
        if (minDistanceSqr > 0 && shieldGroup !== undefined) {
            for (let pointIndex = 0; pointIndex < path.length; ++pointIndex) {
                const point = path[pointIndex];
                // Only process labels frustum-clipped labels
                if (this.m_screenProjector.project(point, tempScreenPosition) !== undefined) {
                    // Find a suitable location for the lineMarker to be placed at.
                    let tooClose = false;
                    for (let j = 0; j < shieldGroup.length; j += 2) {
                        const distanceSqr = Math2D.distSquared(
                            shieldGroup[j],
                            shieldGroup[j + 1],
                            tempScreenPosition.x,
                            tempScreenPosition.y
                        );
                        tooClose = distanceSqr < minDistanceSqr;
                        if (tooClose) {
                            break;
                        }
                    }

                    // Place it as a point label if it's not to close to other marker in the
                    // same shield group.
                    if (!tooClose) {
                        if (
                            this.addPointLabel(
                                labelState,
                                groupState,
                                point,
                                tempScreenPosition,
                                poiRenderer,
                                textCanvas,
                                renderParams,
                                temp,
                                pointIndex
                            )
                        ) {
                            shieldGroup.push(tempScreenPosition.x, tempScreenPosition.y);
                        }
                    }
                }
            }
        }
        // Process markers (without shield groups).
        else {
            for (let pointIndex = 0; pointIndex < path.length; ++pointIndex) {
                const point = path[pointIndex];
                // Only process labels frustum-clipped labels
                if (this.m_screenProjector.project(point, tempScreenPosition) !== undefined) {
                    this.addPointLabel(
                        labelState,
                        groupState,
                        point,
                        tempScreenPosition,
                        poiRenderer,
                        textCanvas,
                        renderParams,
                        temp,
                        pointIndex
                    );
                }
            }
        }
    }

    private addPathLabel(
        labelState: TextElementState,
        groupState: TextElementGroupState,
        screenPoints: THREE.Vector2[],
        textCanvas: TextCanvas,
        renderParams: RenderParams,
        temp: TempParams
    ): boolean {
        // TODO: HARP-7649. Add fade out transitions for path labels.
        const textMaxDistance = getMaxViewDistance(
            this.m_viewState,
            this.m_options.maxDistanceRatioForTextLabels!
        );
        const pathLabel = labelState.element;

        // Limit the text rendering of path labels in the far distance.
        if (
            !(
                pathLabel.ignoreDistance === true ||
                labelState.viewDistance === undefined ||
                labelState.viewDistance < textMaxDistance
            )
        ) {
            if (placementStats) {
                ++placementStats.tooFar;
            }
            labelState.reset();
            return false;
        }

        if (
            pathLabel.fadeFar !== undefined &&
            (pathLabel.fadeFar <= 0.0 ||
                pathLabel.fadeFar * this.m_viewState.maxVisibilityDist < labelState.renderDistance)
        ) {
            // The label is farther away than fadeFar value, which means it is totally
            // transparent
            if (placementStats) {
                ++placementStats.tooFar;
            }
            labelState.reset();
            return false;
        }

        if (!groupState.visited) {
            labelState.reset();
            return false;
        }

        // Compute values common for all glyphs in the label.
        let textScale = textCanvas.textRenderStyle.fontSize.size / 100.0;
        let opacity = pathLabel.renderStyle!.opacity;

        // Get the screen points that define the label's segments and create a path with
        // them.
        let textPath = new THREE.Path();
        tempScreenPosition.copy(screenPoints[0]);
        for (let i = 0; i < screenPoints.length - 1; ++i) {
            textPath.add(new SimpleLineCurve(screenPoints[i], screenPoints[i + 1]));
        }
        // Flip the path if the label is gonna be rendered downwards.
        if (textPath.getPoint(0.5).x - textPath.getPoint(0.51).x > 0) {
            tempScreenPosition.copy(screenPoints[screenPoints.length - 1]);
            textPath = new THREE.Path();
            for (let i = screenPoints.length - 1; i > 0; --i) {
                textPath.add(new SimpleLineCurve(screenPoints[i], screenPoints[i - 1]));
            }
        }

        // Update the real rendering distance to have smooth fading and scaling
        labelState.setViewDistance(computeViewDistance(this.m_viewState.worldCenter, pathLabel));
        const textRenderDistance = -labelState.renderDistance;

        // Scale the text depending on the label's distance to the camera.
        const distanceScaleFactor = this.getDistanceScalingFactor(
            pathLabel,
            textRenderDistance,
            this.m_viewState.lookAtDistance
        );
        textScale *= distanceScaleFactor;

        // Scale the path label correctly.
        const prevSize = textCanvas.textRenderStyle.fontSize.size;
        textCanvas.textRenderStyle.fontSize.size = textScale * 100;

        // Recalculate the text bounds for this path label. If measurement fails, the whole
        // label doesn't fit the path and should be discarded.
        temp.measurementParams.path = textPath;
        temp.measurementParams.outputCharacterBounds = tempBoxes;
        temp.measurementParams.letterCaseArray = pathLabel.glyphCaseArray!;

        // TODO: HARP-7648. TextCanvas.measureText does the placement as in TextCanvas.addText but
        // without storing the result. If the measurement succeeds, the placement work is done
        // twice.
        // This could be done in one step (e.g measureAndAddText). Collision test could be injected
        // in the middle as a function.
        if (!textCanvas.measureText(pathLabel.glyphs!, tempBox, temp.measurementParams)) {
            textCanvas.textRenderStyle.fontSize.size = prevSize;
            if (placementStats) {
                ++placementStats.numNotVisible;
            }
            labelState.reset();
            return false;
        }

        // Perform per-character collision checks.
        for (const charBounds of tempBoxes) {
            tempBox2D.x = tempScreenPosition.x + charBounds.min.x;
            tempBox2D.y = tempScreenPosition.y + charBounds.min.y;
            tempBox2D.w = charBounds.max.x - charBounds.min.x;
            tempBox2D.h = charBounds.max.y - charBounds.min.y;
            if (
                !this.m_screenCollisions.isVisible(tempBox2D) ||
                (!pathLabel.textMayOverlap && this.m_screenCollisions.isAllocated(tempBox2D))
            ) {
                textCanvas.textRenderStyle.fontSize.size = prevSize;
                if (placementStats) {
                    ++placementStats.numNotVisible;
                }
                return false;
            }
        }

        // Fade-in after skipping rendering during movement.
        // NOTE: Shouldn't this only happen once we know the label is gonna be visible?
        if (
            labelState.textRenderState!.isUndefined() ||
            labelState.textRenderState!.lastFrameNumber < this.m_viewState.frameNumber - 1
        ) {
            labelState.textRenderState!.startFadeIn(
                this.m_viewState.frameNumber,
                renderParams.time
            );
        }
        const startedFadeIn = labelState.textRenderState!.checkStartFadeIn(
            this.m_viewState.frameNumber,
            renderParams.time
        );

        renderParams.fadeAnimationRunning = renderParams.fadeAnimationRunning || startedFadeIn;
        if (labelState.textRenderState!.isFading()) {
            opacity = labelState.textRenderState!.opacity * pathLabel.renderStyle!.opacity;
        }

        const prevOpacity = textCanvas.textRenderStyle.opacity;
        const prevBgOpacity = textCanvas.textRenderStyle.backgroundOpacity;
        const distanceFadeFactor = this.getDistanceFadingFactor(
            pathLabel,
            labelState,
            this.m_viewState.maxVisibilityDist
        );
        textCanvas.textRenderStyle.opacity = opacity * distanceFadeFactor;
        textCanvas.textRenderStyle.backgroundOpacity =
            textCanvas.textRenderStyle.opacity * pathLabel.renderStyle!.backgroundOpacity;

        tempPosition.z = labelState.renderDistance;

        temp.additionParams.path = textPath;
        temp.additionParams.layer = pathLabel.renderOrder;
        temp.additionParams.letterCaseArray = pathLabel.glyphCaseArray;
        temp.additionParams.pickingData = pathLabel.userData ? pathLabel : undefined;
        textCanvas.addText(pathLabel.glyphs!, tempPosition, temp.additionParams);

        // Allocate collision info if needed.
        if (pathLabel.textReservesSpace) {
            tempBox2D.x = tempScreenPosition.x + tempBox.min.x;
            tempBox2D.y = tempScreenPosition.y + tempBox.min.y;
            tempBox2D.w = tempBox.max.x - tempBox.min.x;
            tempBox2D.h = tempBox.max.y - tempBox.min.y;
            this.m_screenCollisions.allocate(tempBox2D);
        }

        renderParams.numRenderedTextElements++;

        // Restore previous style values for text elements using the same style.
        textCanvas.textRenderStyle.fontSize.size = prevSize;
        textCanvas.textRenderStyle.opacity = prevOpacity;
        textCanvas.textRenderStyle.backgroundOpacity = prevBgOpacity;
        return true;
    }

    private checkForSmallLabels(textElement: TextElement, screenPoints: THREE.Vector2[]): boolean {
        // Get the screen points that define the label's segments and create a path with
        // them.
        screenPoints.length = 0;
        let anyPointVisible = false;

        for (const pt of textElement.points as THREE.Vector3[]) {
            // Skip invisible points at the beginning of the path.
            const screenPoint = anyPointVisible
                ? this.m_screenProjector.project(pt, tempScreenPosition)
                : this.m_screenProjector.projectOnScreen(pt, tempScreenPosition);
            if (screenPoint === undefined) {
                continue;
            }
            anyPointVisible = true;

            screenPoints.push(tempScreenPosition.clone());
        }

        // TODO: (HARP-3515)
        //      The rendering of a path label that contains just a single point that is not
        //      visible is impossible, which is problematic with long paths.
        //      Fix: Skip/clip the invisible points at beginning and end of the path to get
        //      the visible part of the path.

        // If not a single point is visible, skip the path
        if (!anyPointVisible) {
            return false;
        }

        // Check/guess if the screen box can hold a string of that length. It is important
        // to guess that value without measuring the font first to save time.
        const minScreenSpace = textElement.text.length * MIN_AVERAGE_CHAR_WIDTH;

        tempBox.setFromPoints(screenPoints);
        const boxDiagonalSq = tempBox.max.sub(tempBox.min).lengthSq();

        if (boxDiagonalSq < minScreenSpace * minScreenSpace) {
            textElement.dbgPathTooSmall = true;
            return false;
        }

        return true;
    }

    private checkIfOverloaded(dataSourceTileList: DataSourceTileList[]): boolean {
        // Count the number of TextElements in the scene to see if we have to switch to
        // "overloadMode".
        let numTextElementsInScene = 0;

        dataSourceTileList.forEach(renderListEntry => {
            for (const tile of renderListEntry.renderedTiles.values()) {
                numTextElementsInScene += tile.textElementGroups.count();
                numTextElementsInScene += tile.userTextElements.elements.length;
            }
        });
        const newOverloaded = numTextElementsInScene > OVERLOAD_LABEL_LIMIT;

        if (newOverloaded && !this.m_overloaded) {
            logger.debug("Overloaded Mode enabled.");
        }
        this.m_overloaded = newOverloaded;
        return this.m_overloaded;
    }
}
