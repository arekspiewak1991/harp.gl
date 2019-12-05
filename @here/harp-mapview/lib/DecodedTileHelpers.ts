/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    BufferAttribute,
    getPropertyValue,
    isExtrudedLineTechnique,
    isExtrudedPolygonTechnique,
    isInterpolatedProperty,
    isShaderTechnique,
    isStandardTechnique,
    isTerrainTechnique,
    isTextureBuffer,
    parseStringEncodedColor,
    ShaderTechnique,
    Technique,
    techniqueDescriptors,
    TEXTURE_PROPERTY_KEYS,
    TextureProperties
} from "@here/harp-datasource-protocol";
import { ColorUtils } from "@here/harp-datasource-protocol/lib/ColorUtils";
import {
    CirclePointsMaterial,
    HighPrecisionLineMaterial,
    MapMeshBasicMaterial,
    MapMeshStandardMaterial,
    SolidLineMaterial
} from "@here/harp-materials";
import { assert, LoggerManager } from "@here/harp-utils";
import * as THREE from "three";
import { Circles, Squares } from "./MapViewPoints";
import { toPixelFormat, toTextureDataType, toTextureFilter, toWrappingMode } from "./ThemeHelpers";

const logger = LoggerManager.instance.create("DecodedTileHelpers");

const DEFAULT_SKIP_PROPERTIES = [
    ...TEXTURE_PROPERTY_KEYS,
    "mapProperties",
    "normalMapProperties",
    "displacementMapProperties",
    "roughnessMapProperties",
    "emissiveMapProperties",
    "alphaMapProperties",
    "metalnessMapProperties",
    "bumpMapProperties"
];

/**
 * The structure of the options to pass into [[createMaterial]].
 */
export interface MaterialOptions {
    /**
     * The shader [[Technique]] to choose.
     */
    technique: Technique;

    /**
     * The active zoom level at material creation for zoom-dependent properties.
     */
    level?: number;

    /**
     * Properties to skip.
     *
     * @see [[applyTechniqueToMaterial]]
     */
    skipExtraProps?: string[];

    /**
     * `RawShaderMaterial` instances need to know about the fog at instantiation in order to avoid
     * recompiling them manually later (ThreeJS does not update fog for `RawShaderMaterial`s).
     */
    fog?: boolean;
}

/**
 * Create a material, depending on the rendering technique provided in the options.
 *
 * @param options The material options the subsequent functions need.
 * @param materialUpdateCallback Optional callback when the material gets updated,
 *                               e.g. after texture loading.
 *
 * @returns new material instance that matches `technique.name`
 */
export function createMaterial(
    options: MaterialOptions,
    textureReadyCallback?: (texture: THREE.Texture) => void
): THREE.Material | undefined {
    const technique = options.technique;
    const Constructor = getMaterialConstructor(technique);

    const settings: { [key: string]: any } = {};

    if (Constructor === undefined) {
        return undefined;
    }

    if (
        Constructor.prototype instanceof THREE.RawShaderMaterial &&
        Constructor !== HighPrecisionLineMaterial
    ) {
        settings.fog = options.fog;
    }

    const material = new Constructor(settings);

    if (technique.id !== undefined) {
        material.name = technique.id;
    }

    if (isExtrudedPolygonTechnique(technique)) {
        material.flatShading = true;
    }

    material.depthTest = isExtrudedPolygonTechnique(technique) && technique.depthTest !== false;

    if (
        isStandardTechnique(technique) ||
        isTerrainTechnique(technique) ||
        isExtrudedPolygonTechnique(technique)
    ) {
        TEXTURE_PROPERTY_KEYS.forEach((texturePropertyName: string) => {
            const textureProperty = (technique as any)[texturePropertyName];
            if (textureProperty === undefined) {
                return;
            }

            const onLoad = (texture: THREE.Texture) => {
                const properties = (technique as any)[
                    texturePropertyName + "Properties"
                ] as TextureProperties;
                if (properties !== undefined) {
                    if (properties.wrapS !== undefined) {
                        texture.wrapS = toWrappingMode(properties.wrapS);
                    }
                    if (properties.wrapT !== undefined) {
                        texture.wrapT = toWrappingMode(properties.wrapT);
                    }
                    if (properties.magFilter !== undefined) {
                        texture.magFilter = toTextureFilter(properties.magFilter);
                    }
                    if (properties.minFilter !== undefined) {
                        texture.minFilter = toTextureFilter(properties.minFilter);
                    }
                    if (properties.flipY !== undefined) {
                        texture.flipY = properties.flipY;
                    }
                    if (properties.repeatU !== undefined) {
                        texture.repeat.x = properties.repeatU;
                    }
                    if (properties.repeatV !== undefined) {
                        texture.repeat.y = properties.repeatV;
                    }
                }
                (material as any)[texturePropertyName] = texture;
                texture.needsUpdate = true;
                material.needsUpdate = true;

                if (textureReadyCallback) {
                    textureReadyCallback(texture);
                }
            };

            const onError = (error: ErrorEvent | string) => {
                logger.error("#createMaterial: Failed to load texture: ", error);
            };

            let textureUrl: string | undefined;
            if (typeof textureProperty === "string") {
                textureUrl = textureProperty;
            } else if (isTextureBuffer(textureProperty)) {
                if (textureProperty.type === "image/raw") {
                    const properties = textureProperty.dataTextureProperties;
                    if (properties !== undefined) {
                        const textureDataType: THREE.TextureDataType | undefined = properties.type
                            ? toTextureDataType(properties.type)
                            : undefined;
                        const textureBuffer = getTextureBuffer(
                            textureProperty.buffer,
                            textureDataType
                        );

                        const texture = new THREE.DataTexture(
                            textureBuffer,
                            properties.width,
                            properties.height,
                            properties.format ? toPixelFormat(properties.format) : undefined,
                            textureDataType
                        );
                        onLoad(texture);
                    } else {
                        onError("no data texture properties provided.");
                    }
                } else {
                    const textureBlob = new Blob([textureProperty.buffer], {
                        type: textureProperty.type
                    });
                    textureUrl = URL.createObjectURL(textureBlob);
                }
            }

            if (textureUrl) {
                new THREE.TextureLoader().load(
                    textureUrl,
                    onLoad,
                    undefined, // onProgress
                    onError
                );
            }
        });
    }

    if (isShaderTechnique(technique)) {
        // Special case for ShaderTechnique.
        applyShaderTechniqueToMaterial(technique, material, options.level);
    } else {
        // Generic technique.
        applyTechniqueToMaterial(technique, material, options.level, options.skipExtraProps);
    }

    return material;
}

/**
 * Returns a [[THREE.BufferAttribute]] created from a provided [[BufferAttribute]] object.
 *
 * @param attribute BufferAttribute a WebGL compliant buffer
 */
export function getBufferAttribute(attribute: BufferAttribute): THREE.BufferAttribute {
    switch (attribute.type) {
        case "float":
            return new THREE.BufferAttribute(
                new Float32Array(attribute.buffer),
                attribute.itemCount
            );
        case "uint8":
            return new THREE.BufferAttribute(
                new Uint8Array(attribute.buffer),
                attribute.itemCount,
                attribute.normalized
            );
        case "uint16":
            return new THREE.BufferAttribute(
                new Uint16Array(attribute.buffer),
                attribute.itemCount,
                attribute.normalized
            );
        case "uint32":
            return new THREE.BufferAttribute(
                new Uint32Array(attribute.buffer),
                attribute.itemCount,
                attribute.normalized
            );
        case "int8":
            return new THREE.BufferAttribute(
                new Int8Array(attribute.buffer),
                attribute.itemCount,
                attribute.normalized
            );
        case "int16":
            return new THREE.BufferAttribute(
                new Int16Array(attribute.buffer),
                attribute.itemCount,
                attribute.normalized
            );
        case "int32":
            return new THREE.BufferAttribute(
                new Int32Array(attribute.buffer),
                attribute.itemCount,
                attribute.normalized
            );
        default:
            throw new Error(`unsupported buffer of type ${attribute.type}`);
    } // switch
}

/**
 * The default `three.js` object used with a specific technique.
 */
export type ObjectConstructor = new (
    geometry?: THREE.Geometry | THREE.BufferGeometry,
    material?: THREE.Material
) => THREE.Object3D;
/**
 * Gets the default `three.js` object constructor associated with the given technique.
 *
 * @param technique The technique.
 */
export function getObjectConstructor(technique: Technique): ObjectConstructor | undefined {
    if (technique.name === undefined) {
        return undefined;
    }
    switch (technique.name) {
        case "extruded-line":
        case "standard":
        case "terrain":
        case "extruded-polygon":
        case "fill":
        case "dashed-line":
        case "solid-line":
            return THREE.Mesh as ObjectConstructor;

        case "circles":
            return Circles as ObjectConstructor;
        case "squares":
            return Squares as ObjectConstructor;

        case "line":
            return THREE.LineSegments as ObjectConstructor;

        case "segments":
            return THREE.LineSegments as ObjectConstructor;

        case "shader": {
            if (!isShaderTechnique(technique)) {
                throw new Error("Invalid technique");
            }
            switch (technique.primitive) {
                case "line":
                    return THREE.Line as ObjectConstructor;
                case "segments":
                    return THREE.LineSegments as ObjectConstructor;
                case "point":
                    return THREE.Points as ObjectConstructor;
                case "mesh":
                    return THREE.Mesh as ObjectConstructor;
                default:
                    return undefined;
            }
        }

        case "text":
        case "labeled-icon":
        case "line-marker":
        case "label-rejection-line":
            return undefined;
    }
}

/**
 * Non material properties of [[BaseTechnique]]
 */
export const BASE_TECHNIQUE_NON_MATERIAL_PROPS = [
    "name",
    "id",
    "renderOrder",
    "renderOrderBiasProperty",
    "renderOrderBiasGroup",
    "renderOrderBiasRange",
    "transient"
];

/**
 * Generic material type constructor.
 */
export type MaterialConstructor = new (params?: {}) => THREE.Material;

/**
 * Returns a [[MaterialConstructor]] basing on provided technique object.
 *
 * @param technique [[Technique]] object which the material will be based on.
 */
export function getMaterialConstructor(technique: Technique): MaterialConstructor | undefined {
    if (technique.name === undefined) {
        return undefined;
    }

    switch (technique.name) {
        case "extruded-line":
            if (!isExtrudedLineTechnique(technique)) {
                throw new Error("Invalid extruded-line technique");
            }
            return technique.shading === "standard"
                ? MapMeshStandardMaterial
                : MapMeshBasicMaterial;

        case "standard":
        case "terrain":
        case "extruded-polygon":
            return MapMeshStandardMaterial;

        case "dashed-line":
        case "solid-line":
            return SolidLineMaterial;

        case "fill":
            return MapMeshBasicMaterial;

        case "squares":
            return THREE.PointsMaterial;

        case "circles":
            return CirclePointsMaterial;

        case "line":
        case "segments":
            return THREE.LineBasicMaterial;

        case "shader":
            return THREE.ShaderMaterial;

        case "text":
        case "labeled-icon":
        case "line-marker":
        case "label-rejection-line":
            return undefined;
    }
}

/**
 * Apply [[ShaderTechnique]] parameters to material.
 *
 * @param technique the [[ShaderTechnique]] which requires special handling
 * @param material material to which technique will be applied
 * @param level optional, tile zoom level, for properties zoom level dependent.
 */
function applyShaderTechniqueToMaterial(
    technique: ShaderTechnique,
    material: THREE.Material,
    level?: number
) {
    // The shader technique takes the argument from its `params' member.
    const params = technique.params as { [key: string]: any };
    const props = Object.getOwnPropertyNames(params).filter(property => {
        const prop = property as keyof typeof params;
        if (prop === "name") {
            // skip reserved property names
            return false;
        }
        return true;
    });

    // Remove transparent color from the firstly processed properties set.
    const baseColorPropName = getBaseColorPropName(technique);
    const hasBaseColor = baseColorPropName && baseColorPropName in technique;
    if (hasBaseColor) {
        removePropFromArray(props, baseColorPropName!);
        removePropFromArray(props, "opacity");
        removePropFromArray(props, "transparent");
    }

    // Apply all technique properties omitting base color.
    props.forEach(property => {
        const prop = property as keyof typeof params;
        // TODO: Check if params[prop] - value should not be interpolated - possible bug!
        // If the flow (interpolation) should be the same as in applyTechniqueToMaterial()
        // we could simplify the functions a lot!
        applyTechniquePropertyToMaterial(technique, material, prop, params[prop], level);
    });

    if (hasBaseColor) {
        const propColor = baseColorPropName as keyof typeof technique;
        // Finally apply base color and related properties to material (opacity, transparent)
        applyTechniqueBaseColorToMaterial(technique, material, propColor, params[propColor], level);
    }
}

/**
 * Apply generic technique parameters to material.
 *
 * Skips non-material [[Technique]] props:
 *  * [[BaseTechnique]] props,
 *  * `name` which is used as discriminator for technique types,
 *  * props starting with `_`
 *  * props found `skipExtraProps`
 *
 * `THREE.Color` properties are supported.
 *
 * @param technique technique from where params are copied
 * @param material target material
 * @param level optional, tile zoom level for zoom-level dependent props
 * @param skipExtraProps optional, skipped props.
 */
export function applyTechniqueToMaterial(
    technique: Technique,
    material: THREE.Material,
    level?: number,
    skipExtraProps?: string[]
) {
    const genericProps = Object.getOwnPropertyNames(technique).filter(propertyName => {
        if (
            propertyName.startsWith("_") ||
            BASE_TECHNIQUE_NON_MATERIAL_PROPS.indexOf(propertyName) !== -1 ||
            DEFAULT_SKIP_PROPERTIES.indexOf(propertyName) !== -1 ||
            (skipExtraProps !== undefined && skipExtraProps.indexOf(propertyName) !== -1)
        ) {
            return false;
        }
        const prop = propertyName as keyof typeof technique;
        const m = material as any;
        if (typeof m[prop] === "undefined") {
            return false;
        }
        return true;
    });

    // Remove transparent color from the firstly processed properties set.
    const baseColorPropName = getBaseColorPropName(technique);
    const hasBaseColor = baseColorPropName && baseColorPropName in technique;
    if (hasBaseColor) {
        removePropFromArray(genericProps, baseColorPropName!);
        removePropFromArray(genericProps, "opacity");
        removePropFromArray(genericProps, "transparent");
    }

    // Apply all other properties (even colors), but not transparent (base) ones.
    genericProps.forEach(propertyName => {
        const prop = propertyName as keyof typeof technique;
        let value = technique[prop];
        if (level !== undefined && isInterpolatedProperty(value)) {
            value = getPropertyValue(value, level);
        }
        applyTechniquePropertyToMaterial(technique, material, prop, value, level);
    });

    // Finally apply base (transparent) color itself, modifying material.opacity and
    // material.transparent attributes too.
    if (hasBaseColor) {
        const propColor = baseColorPropName as keyof typeof technique;
        let value = technique[propColor];
        if (level !== undefined && isInterpolatedProperty(value)) {
            value = getPropertyValue(value, level);
        }
        applyTechniqueBaseColorToMaterial(technique, material, propColor, value, level);
    }
}

/**
 * Apply single and generic technique property to corresponding material parameter.
 *
 * @note Special handling for material attributes of [[THREE.Color]] type is provided thus it
 * does not provide constructor that would take [[string]] or [[number]] values.
 *
 * @param material target material
 * @param prop material and technique parameter name (or index) that is to be transferred
 * @param value technique property value which will be applied to corresponding material
 * attribute.
 */
function applyTechniquePropertyToMaterial(
    technique: Technique,
    material: THREE.Material,
    prop: string | number,
    value: any,
    level?: number
) {
    const m = material as any;
    if (m[prop] instanceof THREE.Color) {
        applyTechniqueColorToMaterial(technique, material, prop, value, level);
    } else {
        m[prop] = value;
    }
}

/**
 * Apply technique color to material taking special care with transparent (RGBA) colors.
 *
 * @note This function is intended to be used with secondary, triary etc. technique colors,
 * not the base ones that may contain transparency information. Such colors should be processed
 * with [[applyTechniqueBaseColorToMaterial]] function.
 *
 * @param technique an technique the applied color comes from
 * @param material the material to which color is applied
 * @param prop technique property (color) name
 * @param value color value
 * @param level optional, tile zoom level for zoom-level dependent properties are evaluated.
 */
function applyTechniqueColorToMaterial(
    technique: Technique,
    material: THREE.Material,
    prop: string | number,
    value: any,
    level?: number
) {
    const m = material as any;
    assert(m[prop] instanceof THREE.Color);
    assert(
        !isBaseColorProp(technique, prop),
        "Main (transparent) technique colors should not be processed here!"
    );

    if (typeof value === "string") {
        value = parseStringEncodedColor(value);
        if (value === undefined) {
            throw new Error(`Unsupported color format: '${value}'`);
        }
    }

    if (ColorUtils.hasAlphaInHex(value)) {
        logger.warn("Used RGBA value for technique color without transparency support!");
        // Just for clarity remove transparency component, even if that would be ignored
        // by THREE.Color.setHex() function.
        value = ColorUtils.removeAlphaFromHex(value);
    }

    m[prop].setHex(value);
    // Trigger setter notifying change
    m[prop] = m[prop];
}

/**
 * Apply technique base color (transparency support) to material with modifying material opacity.
 *
 * This method applies main (or base) technique color with transparency support to the corresponding
 * material color, with an effect on entire [[THREE.Material]] __opacity__ and __transparent__
 * attributes.
 *
 * @note Transparent colors should be processed as the very last technique attributes,
 * since their effect on material properties like [[THREE.Material.opacity]] and
 * [[THREE.Material.transparent]] could be overridden by corresponding technique params.
 *
 * @param technique an technique the applied color comes from
 * @param material the material to which color is applied
 * @param prop technique property (color) name
 * @param value color value in custom number format
 * @param level optional, tile zoom level for zoom-level dependent properties are evaluated.
 */
function applyTechniqueBaseColorToMaterial(
    technique: Technique,
    material: THREE.Material,
    prop: string | number,
    value: any,
    level?: number
) {
    const m = material as any;
    assert(m[prop] instanceof THREE.Color);
    assert(
        isBaseColorProp(technique, prop),
        "Secondary technique colors should not be processed here!"
    );

    if (typeof value === "string") {
        value = parseStringEncodedColor(value);
        if (value === undefined) {
            throw new Error(`Unsupported color format: '${value}'`);
        }
    }

    const { r, g, b, a } = ColorUtils.getRgbaFromHex(value);
    // Override material opacity and transparency by mixing technique defined opacity
    // with main color transparency
    const tech = technique as any;
    let opacity = a;
    if (tech.opacity !== undefined) {
        opacity *=
            level !== undefined && isInterpolatedProperty(tech.opacity)
                ? getPropertyValue(tech.opacity, level)
                : tech.opacity;
    }
    opacity = THREE.Math.clamp(opacity, 0, 1);
    let transparent = opacity !== 1.0;
    if (tech.transparent !== undefined) {
        transparent =
            transparent ||
            (level !== undefined && isInterpolatedProperty(tech.transparent)
                ? getPropertyValue(tech.transparent, level)
                : tech.transparent);
    }
    material.opacity = opacity;
    material.transparent = transparent;
    m[prop].setRGB(r, g, b);
    // Trigger setter notifying change
    m[prop] = m[prop];
}

function getBaseColorPropName(technique: Technique): string | undefined {
    const techDescriptor = techniqueDescriptors[technique.name];
    return techDescriptor !== undefined ? techDescriptor.attrTransparencyColor : undefined;
}

function isBaseColorProp(technique: Technique, propertyName: string | number): boolean {
    return getBaseColorPropName(technique) === propertyName;
}

function removePropFromArray(propsArray: string[], prop: string): boolean {
    const idx = propsArray.indexOf(prop);
    return idx >= 0 ? propsArray.splice(idx, 1).length > 0 : false;
}

function getTextureBuffer(
    buffer: ArrayBuffer,
    textureDataType: THREE.TextureDataType | undefined
): THREE.TypedArray {
    if (textureDataType === undefined) {
        return new Uint8Array(buffer);
    }

    switch (textureDataType) {
        case THREE.UnsignedByteType:
            return new Uint8Array(buffer);
        case THREE.ByteType:
            return new Int8Array(buffer);
        case THREE.ShortType:
            return new Int16Array(buffer);
        case THREE.UnsignedShortType:
            return new Uint16Array(buffer);
        case THREE.IntType:
            return new Int32Array(buffer);
        case THREE.UnsignedIntType:
            return new Uint32Array(buffer);
        case THREE.FloatType:
            return new Float32Array(buffer);
        case THREE.HalfFloatType:
            return new Uint16Array(buffer);
    }

    throw new Error("Unsupported texture data type");
}
