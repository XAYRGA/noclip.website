
import ArrayBufferSlice from "../../ArrayBufferSlice";
import { readFileSync, writeFileSync } from "fs";
import { assert, hexzero0x, readString } from "../../util";
import * as AFS from '../AFS';
import * as BYML from "../../byml";

function fetchDataSync(path: string): ArrayBufferSlice {
    const b: Buffer = readFileSync(path);
    return new ArrayBufferSlice(b.buffer);
}

const pathBaseIn  = `../../../data/JetSetRadio_Raw`;
const pathBaseOut = `../../../data/JetSetRadio`;

const EXECUTABLE_ALLOCATION_ADDRESS = 0x8C010000;
const STAGE_ALLOCATION_ADDRESS = 0x8CB00000;

interface AFSRefData {
    AFSFileName: string;
    AFSFileIndex: number;
}

interface TexData extends AFSRefData {
    Offset: number;
}

interface TexlistData {
    Textures: TexData[];
    Texlists: number[][];
}

interface ModelData extends AFSRefData {
    Offset: number;
    TexlistIndex: number;
}

interface ObjectData {
    ModelID: number;
    Translation: [number, number, number];
    Rotation: [number, number, number];
    Scale: [number,number,number];
    Flags: number;
}

interface StageSliceData {
    Models: ModelData[];
    Objects: ObjectData[];
}

interface StageData extends StageSliceData {
    TexlistData: TexlistData;
}

class AFSReference {
    constructor(public afsFilename: string, public afsIndex: number, public buffer: ArrayBufferSlice) {
    }

    public getRefData(): AFSRefData {
        return { AFSFileName: this.afsFilename, AFSFileIndex: this.afsIndex };
    }
}

function txpHasTexture(file: AFSReference, offset: number): boolean {
    if (offset >= file.buffer.byteLength)
        return false;

    return readString(file.buffer, offset, 0x04, false) === 'GBIX';
}

function afsLoad(afsFilename: string, afsIndex: number): AFSReference {
    const data = AFS.parse(fetchDataSync(`${pathBaseOut}/JETRADIO/${afsFilename}`));
    const buffer = data.files[afsIndex];
    return new AFSReference(afsFilename, afsIndex, buffer);
}

interface TexlistRefTableEntry {
    texlistAddr: number;
    slot: number;
}

function parseTexlistRefTable(execBuffer: ArrayBufferSlice, refTableAddr: number): TexlistRefTableEntry[] {
    const view = execBuffer.createDataView();
    
    const refTable: TexlistRefTableEntry[] = [];

    let refTableOffs = refTableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    while (true) {
        const texlistAddr = view.getUint32(refTableOffs + 0x00, true);
        const slot = view.getUint32(refTableOffs + 0x04, true);
        refTableOffs += 0x08;

        if (texlistAddr === 0x00000000 && slot === 0xFFFFFFFF)
            break;

        refTable.push({ texlistAddr, slot });
    }

    return refTable;
}

interface Texlist {
    addr: number;
    entries: number[];
}

class TexChunk {
    public textures: TexData[] = [];
    public texlists: Texlist[] = [];
}

function packTexListData(texChunk: TexChunk): TexlistData {
    const Textures = texChunk.textures;
    const Texlists = texChunk.texlists.map((v) => v.entries);
    return { Textures, Texlists };
}

function extractFilenameTable(execBuffer: ArrayBufferSlice, tableAddr: number = 0x8C19428C): string[] {
    const filenames: string[] = [];
    let tableOffs = tableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    while (true) {
        const filename = readString(execBuffer, tableOffs);
        if (!filename.length)
            break;
        tableOffs += filename.length + 1;
        filenames.push(filename);
    }
    return filenames;
}

function extractTexPackTable_01(dst: TexChunk, execBuffer: ArrayBufferSlice, txpFile: AFSReference, tableAddr: number, texLoadAddr: number): void {
    const view = execBuffer.createDataView();
    
    //console.log(`01 EXEC ARC  ${txpFile.afsFilename} ${txpFile.afsIndex} ${hexzero0x(tableAddr)}`);


    const getTexlist = (addr: number) => {
        let existing = dst.texlists.find((v) => v.addr === addr);
        if (existing === undefined) {
            existing = { addr, entries: [] };
            dst.texlists.push(existing);
        }
        return existing;
    };

    const insertRef = (ref: TexlistRefTableEntry, index: number) => {
        const texlist = getTexlist(ref.texlistAddr);
        // console.log(`  ${hexzero0x(ref.texlistAddr)} ${hexzero0x(ref.slot)}`);
        texlist.entries[ref.slot] = index;
    };

    let tableOffs = tableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    // console.log(`01 ${txpFile.afsFilename} ${hexzero0x(tableAddr)} ${hexzero0x(tableOffs)}`);
    while (true) {
        const refTableAddr = view.getUint32(tableOffs + 0x00, true);
        const txpAddr = view.getUint32(tableOffs + 0x04, true);


        tableOffs += 0x08;
        if (refTableAddr === 0x00000000 && (txpAddr === 0xFFFFFFFF || txpAddr === 0x00000000 ))
            break;
        if (txpAddr === 0x00000000)
            continue;

        const txpOffs = txpAddr - texLoadAddr;

        assert(txpOffs >= 0);
    
        const texDataIndex = dst.textures.push({ ... txpFile.getRefData(), Offset: txpOffs }) - 1;

        const refTable = parseTexlistRefTable(execBuffer, refTableAddr);
        for (let i = 0; i < refTable.length; i++)
            insertRef(refTable[i], texDataIndex);
    }
}

function extractTexPackTable_02(dst: TexChunk, execBuffer: ArrayBufferSlice, txpFile: AFSReference, tableAddr: number, texLoadAddr: number): void {
    const view = execBuffer.createDataView();

    let tableOffs = tableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    

    const texlistAddr = view.getUint32(tableOffs + 0x00, true);
    const texlistOffs = texlistAddr - EXECUTABLE_ALLOCATION_ADDRESS;

    const texdataAddr = view.getUint32(tableOffs + 0x04, true);
    let texdataOffs = texdataAddr - EXECUTABLE_ALLOCATION_ADDRESS;

    const texlistCount = view.getUint32(texlistOffs + 0x04, true);

    const entries: number[] = [];
    dst.texlists.push({ addr: texlistAddr, entries });


    for (let i = 0; i < texlistCount; i++) {
       
        const txpAddr = view.getUint32(texdataOffs + 0x00, true);
        texdataOffs += 0x04;

        const txpOffs = txpAddr - texLoadAddr;
        assert(txpOffs >= 0);

        const texDataIndex = dst.textures.push({ ... txpFile.getRefData(), Offset: txpOffs }) - 1;
        // console.log(`  ${hexzero0x(texlistAddr)} ${hexzero0x(i)} ${hexzero0x(txpAddr)}`);
        entries.push(texDataIndex);
    }
}

function extractTexPackTable_03(dst: TexChunk, execBuffer: ArrayBufferSlice, txpFile: AFSReference, tableAddr: number, texLoadAddr: number): void {
    const view = execBuffer.createDataView();

    const getTexlist = (addr: number) => {
        let existing = dst.texlists.find((v) => v.addr === addr);
        if (existing === undefined) {
            existing = { addr, entries: [] };
            dst.texlists.push(existing);
        }
        return existing;
    };

    const insertRef = (ref: TexlistRefTableEntry, index: number) => {
        const texlist = getTexlist(ref.texlistAddr);
        // console.log(`  ${hexzero0x(ref.texlistAddr)} ${hexzero0x(ref.slot)}`);
        texlist.entries[ref.slot] = index;
    };

    let tableOffs = tableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    // console.log(`01 ${txpFile.afsFilename} ${hexzero0x(tableAddr)} ${hexzero0x(tableOffs)}`);
    while (true) {
        const refTableAddr = view.getUint32(tableOffs + 0x00, true);
        const txpAddr = view.getUint32(tableOffs + 0x04, true);

        tableOffs += 0x08;
        if (refTableAddr === 0x00000000 && txpAddr === 0x00000000)
            break;
        if (txpAddr === 0x00000000)
            continue;

        const txpOffs = txpAddr - texLoadAddr;
        assert(txpOffs >= 0);

        const texDataIndex = dst.textures.push({ ... txpFile.getRefData(), Offset: txpOffs }) - 1;

        const refTable = parseTexlistRefTable(execBuffer, refTableAddr);
        for (let i = 0; i < refTable.length; i++)
            insertRef(refTable[i], texDataIndex);
    }
}

function extractTexLoadTable(texChunk: TexChunk, execBuffer: ArrayBufferSlice, tableAddr: number , texLoadOverride: number = 0, textableFormatOverride : number = 0, maxDepth: number = 0): void {
    const filenames = extractFilenameTable(execBuffer);

    const view = execBuffer.createDataView();
    let depth = 0;
    let tableOffs = tableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    while (true) {
        if (depth === maxDepth&&maxDepth !== 0)
            break;

        depth++;
    
        const afsFileID = view.getUint32(tableOffs + 0x00, true);
        const afsIndex = view.getUint32(tableOffs + 0x04, true);
        let texLoadAddr = view.getUint32(tableOffs + 0x08, true);

        const texPackTableAddr = view.getUint32(tableOffs + 0x0C, true);
        let texListType = view.getUint32(tableOffs + 0x10, true);
        tableOffs += 0x20;
        if (texPackTableAddr === 0x00000000 && afsFileID === 0 && afsIndex === 0 && texListType === 0 && texLoadAddr === 0)
            break;
        if (texPackTableAddr === 0) 
            continue;
        if (texLoadOverride > 0)
            texLoadAddr = texLoadOverride;
        // xayrga: will we ever load the segalogo?
        if (afsFileID === 0)
            continue;
        const afsFilename = filenames[afsFileID];
        if (!afsFilename)
            continue;
        const txpFile = afsLoad(afsFilename, afsIndex);
        if (texListType === 0)
            continue;
        if (textableFormatOverride > 0)
            texListType = textableFormatOverride;
        if (texListType === 0x01)
            extractTexPackTable_01(texChunk, execBuffer, txpFile, texPackTableAddr, texLoadAddr);
        else if (texListType === 0x02)
            extractTexPackTable_02(texChunk, execBuffer, txpFile, texPackTableAddr, texLoadAddr);
        else if (texListType === 0x03 || texListType === 0x04 || texListType === 0x05)
            extractTexPackTable_03(texChunk, execBuffer, txpFile, texPackTableAddr, 0x8CDA0000);
        else
            throw `Invalid texlist format ${texListType}`;
    }
}

function findTexlistIndex(texlists: Texlist[], texlistAddr: number): number {
    return texlists.findIndex((v) => v.addr === texlistAddr);
}

function extractModelTable(execBuffer: ArrayBufferSlice, texlists: Texlist[], afsFile: AFSReference, modelTableAddr: number, texlistTableAddr: number, tableCount: number): ModelData[] {
    const modelTable = execBuffer.createTypedArray(Uint32Array, modelTableAddr - EXECUTABLE_ALLOCATION_ADDRESS, tableCount);
    const texlistTable = execBuffer.createTypedArray(Uint32Array, texlistTableAddr - EXECUTABLE_ALLOCATION_ADDRESS, tableCount);

    const models: ModelData[] = [];
    for (let i = 0; i < tableCount; i++) {
        const modelAddr = modelTable[i];
        const modelOffs = modelAddr - STAGE_ALLOCATION_ADDRESS;
        const texlistAddr = texlistTable[i];
        const texlistIndex = findTexlistIndex(texlists, texlistAddr);
        if (texlistIndex < 0 && texlistAddr !== 0)
            console.warn(`Model ${hexzero0x(modelTableAddr)} / ${hexzero0x(i, 2)} (NJ addr ${hexzero0x(modelAddr)}) could not find texlist with addr: ${hexzero0x(texlistAddr)}`);
        models.push({ ... afsFile.getRefData(), Offset: modelOffs, TexlistIndex: texlistIndex });
    }
    return models;
}

const rotToRadians = Math.PI / 0x8000;

function extractObjectInstance_01(stageBuffer: ArrayBufferSlice, instanceAddr: number): ObjectData {
    const stageView = stageBuffer.createDataView();

    const instanceOffs = instanceAddr - STAGE_ALLOCATION_ADDRESS;
    const modelID = stageView.getUint32(instanceOffs + 0x00, true);

    const translationX = stageView.getFloat32(instanceOffs + 0x04, true);
    const translationY = stageView.getFloat32(instanceOffs + 0x08, true);
    const translationZ = stageView.getFloat32(instanceOffs + 0x0C, true);
    const rotationX = rotToRadians * stageView.getInt16(instanceOffs + 0x10, true);
    const rotationY = rotToRadians * stageView.getInt16(instanceOffs + 0x14, true);
    const rotationZ = rotToRadians * stageView.getInt16(instanceOffs + 0x18, true);
    return {
        ModelID: modelID,
        Translation: [translationX, translationY, translationZ],
        Rotation: [rotationX, rotationY, rotationZ],
        Scale: [1,1,1], 
        Flags: 0
    };
}



function extractObjectInstance_02(stageBuffer: ArrayBufferSlice, instanceAddr: number, dataSize:number = 0x24): ObjectData {
    const stageView = stageBuffer.createDataView();
    //console.warn(`Instance ${hexzero0x(instanceAddr)}`)
    const instanceOffs = instanceAddr - STAGE_ALLOCATION_ADDRESS;
    const modelID = stageView.getUint32(instanceOffs + 0x00, true);

    const translationX = stageView.getFloat32(instanceOffs + 0x04, true);
    const translationY = stageView.getFloat32(instanceOffs + 0x08, true);
    const translationZ = stageView.getFloat32(instanceOffs + 0x0C, true);
    const rotationX = rotToRadians * stageView.getInt16(instanceOffs + 0x10, true);
    const rotationY = rotToRadians * stageView.getInt16(instanceOffs + 0x14, true);
    const rotationZ = rotToRadians * stageView.getInt16(instanceOffs + 0x18, true);
    const scaleX = stageView.getFloat32(instanceOffs + 0x1C, true); // xayrga: todo, figure out why these are 0 on a lot of objects.
    const scaleY = stageView.getFloat32(instanceOffs + 0x20, true);
    const scaleZ = stageView.getFloat32(instanceOffs + 0x24, true);
    let flags = 0;
    if (dataSize >= 0x28)
        flags = stageView.getFloat32(instanceOffs + 0x28, true);

    return {
        ModelID: modelID,
        Translation: [translationX, translationY, translationZ],
        Rotation: [rotationX, rotationY, rotationZ],
        Scale: [scaleX,scaleY,scaleZ], //xayrga: todo, confirm if this is actually scaling in the data
        Flags: flags // xayrga: todo, confirm if this actually functions as a flag.
    };
}

function extractObjectTableGrouped(execBuffer: ArrayBufferSlice, afsFile: AFSReference, tableAddr: number, tableCount: number): ObjectData[] {
    const tableOffs = tableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    const objGroupPtrs = execBuffer.createTypedArray(Uint32Array, tableOffs, tableCount);

    const stageView = afsFile.buffer.createDataView();
    const objects: ObjectData[] = [];
    for (let i = 0; i < tableCount; i++) {
        const instanceListAddr = objGroupPtrs[i];
        if (instanceListAddr === 0)
            continue;
        let instanceListOffs = instanceListAddr - STAGE_ALLOCATION_ADDRESS;
        for (;; instanceListOffs += 0x04) {
            const instanceAddr = stageView.getUint32(instanceListOffs + 0x00, true);
            if (((instanceAddr & 0xF0000000) >>> 0) !== 0x80000000)
                break;
            const object = extractObjectInstance_01(afsFile.buffer, instanceAddr);
            if (object.ModelID === 0xFFFFFFFF)
                continue;
            objects.push(object);
        }
    }
    return objects;
}

function extractObjectTableSingles(execBuffer: ArrayBufferSlice, afsFile: AFSReference, tableAddr: number, tableCount: number): ObjectData[] {
    const tableOffs = tableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    const objGroupPtrs = execBuffer.createTypedArray(Uint32Array, tableOffs, tableCount);

    const objects: ObjectData[] = [];
    for (let i = 0; i < tableCount; i++) {
        let instanceAddr = objGroupPtrs[i];
        if (instanceAddr === 0)
            continue;
        for (;; instanceAddr += 0x28) {
            const object = extractObjectInstance_01(afsFile.buffer, instanceAddr);
            if (object.ModelID === 0xFFFFFFFF) {
                continue;
            } else if (object.ModelID === 0xFFFFFFFE) {
                break;
            }
            objects.push(object);
        }
    }
    return objects;
}


function extractObjectTableSinglesSize(execBuffer: ArrayBufferSlice, afsFile: AFSReference, tableAddr: number, tableCount: number, significantDataSize: number): ObjectData[] {
    const tableOffs = tableAddr - EXECUTABLE_ALLOCATION_ADDRESS;
    const objGroupPtrs = execBuffer.createTypedArray(Uint32Array, tableOffs, tableCount);

    const objects: ObjectData[] = [];
    for (let i = 0; i < tableCount; i++) {
        let instanceAddr = objGroupPtrs[i];
        if (instanceAddr === 0)
            continue;
        for (;; instanceAddr += significantDataSize) {
            const object = extractObjectInstance_02(afsFile.buffer, instanceAddr, significantDataSize);
            if (object.ModelID === 0xFFFFFFFF) {
                continue;
            } else if (object.ModelID === 0xFFFFFFFE) {
                break;
            }
            objects.push(object);
        }
    }
    return objects;
}



function packStageData(texChunk: TexChunk, slices: StageSliceData[]): StageData {
    const TexlistData = packTexListData(texChunk);

    const Models: ModelData[] = [];
    const Objects: ObjectData[] = [];

    for (let i = 0; i < slices.length; i++) {
        const slice = slices[i];
        const modelsStart = Models.length;
        Models.push(... slice.Models);
        Objects.push(... slice.Objects.map((v) => {
            return { ...v, ModelID: v.ModelID + modelsStart };
        }));
    }

    return { TexlistData, Models, Objects };
}

function saveStageData(dstFilename: string, crg1: StageData): void {
    const data = BYML.write(crg1, BYML.FileType.CRG1);
    writeFileSync(dstFilename, Buffer.from(data));
}

function extractStage1(dstFilename: string, execBuffer: ArrayBufferSlice): void {
    const texChunk = new TexChunk();

    extractTexLoadTable(texChunk, execBuffer, 0x8c185b30);
    extractTexLoadTable(texChunk, execBuffer, 0x8c1a49a8);
    extractTexLoadTable(texChunk, execBuffer, 0x8c1a49c8);
    extractTexLoadTable(texChunk, execBuffer, 0x8c1a4a28);
    extractTexLoadTable(texChunk, execBuffer, 0x8c1a4a88);

    const SCENE_FILE = afsLoad('STAGE1.AFS', 0);

    function extractSlice1() {
        const ASSET_TABLE_ADDRESS = 0x8c1063b4;
        const TEXTURE_TABLE_ADDRESS = 0x8c106648;
        const OBJECT_TABLE_ADDRESS = 0x8c105e98;
        const ASSET_COUNT = 165;
        const OBJECT_COUNT = 62;
    
        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableGrouped(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT);
        return { Models, Objects };
    }

    function extractSlice2() {
        const ASSET_TABLE_ADDRESS = 0x8c106e0c;
        const TEXTURE_TABLE_ADDRESS = 0x8c106ed4;
        const OBJECT_TABLE_ADDRESS = 0x8c105f94;
        const ASSET_COUNT = 49;
        const OBJECT_COUNT = 63;

        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableGrouped(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT);
        return { Models, Objects };
    }

    function extractSlice3() {
        const ASSET_TABLE_ADDRESS = 0x8c10712c;
        const TEXTURE_TABLE_ADDRESS = 0x8c107204;
        const OBJECT_TABLE_ADDRESS = 0x8c106090
        const ASSET_COUNT = 54;
        const OBJECT_COUNT = 51;
  
        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableSingles(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT);
        return { Models, Objects };
    }

    const slice1 = extractSlice1();
    const slice2 = extractSlice2();
    const slice3 = extractSlice3();

    const crg1 = packStageData(texChunk, [slice1, slice2, slice3]);
    saveStageData(dstFilename, crg1);
}

function extractStage2(dstFilename: string, execBuffer: ArrayBufferSlice): void {
    const texChunk = new TexChunk();


    extractTexLoadTable(texChunk, execBuffer, 0x8c1b3f28, 0x8cDA0000, 1, 2);
    extractTexLoadTable(texChunk, execBuffer, 0x8c1b3f88, 0x8CDA0000, 1, 2);
    extractTexLoadTable(texChunk, execBuffer, 0x8c186c38);
    extractTexLoadTable(texChunk, execBuffer, 0x8c186530);

    const SCENE_FILE = afsLoad('STAGE2.AFS', 0);

    function extractSlice1() {
        const ASSET_TABLE_ADDRESS = 0x8c1086a0;
        const TEXTURE_TABLE_ADDRESS = 0x8c108834;
        const OBJECT_TABLE_ADDRESS = 0x8c107d2c;
        const ASSET_COUNT = 101;
        const OBJECT_COUNT = 114;
        const OBJECTDATA_SIZE = 0x34;
    
        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableSinglesSize(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT, OBJECTDATA_SIZE);
        return { Models, Objects };
    }

    function extractSlice2() {
        const ASSET_TABLE_ADDRESS = 0x8c108cf0;
        const TEXTURE_TABLE_ADDRESS = 0x8c10920c;
        const OBJECT_TABLE_ADDRESS = 0x8c107ef4;
        const ASSET_COUNT = 327;
        const OBJECT_COUNT = 114;
        const OBJECTDATA_SIZE = 0x28;

        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableSinglesSize(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT, OBJECTDATA_SIZE);
        return { Models, Objects };
    }

    function extractSlice3() {
        const ASSET_TABLE_ADDRESS = 0x8c109728;
        const TEXTURE_TABLE_ADDRESS = 0x8c10985c;
        const OBJECT_TABLE_ADDRESS = 0x8c1080bc;
        const ASSET_COUNT = 80;
        const OBJECT_COUNT = 21;
        const OBJECTDATA_SIZE = 0x34;
    
        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableSinglesSize(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT, OBJECTDATA_SIZE);
        return { Models, Objects };
    }

    const slice1 = extractSlice1();
    const slice2 = extractSlice2();
    const slice3 = extractSlice3();

    const crg1 = packStageData(texChunk, [slice1 , slice2, slice3]);
    saveStageData(dstFilename, crg1);
}


function extractStage3(dstFilename: string, execBuffer: ArrayBufferSlice): void {
    const texChunk = new TexChunk();

    extractTexLoadTable(texChunk, execBuffer, 0x8c1c7350,0x8cf00000, 1, 4);
    extractTexLoadTable(texChunk, execBuffer, 0x8c185db0);
    extractTexLoadTable(texChunk, execBuffer, 0x8c1c6430, 0x8Cf00000,1,5);
    extractTexLoadTable(texChunk, execBuffer, 0x8c1c7290, 0x8Cf00000,1);
    const SCENE_FILE = afsLoad('STAGE3.AFS', 0);

    function extractSlice1() {
        const ASSET_TABLE_ADDRESS = 0x8c1bab40;
        const TEXTURE_TABLE_ADDRESS = 0x8c1bad0c;
        const OBJECT_TABLE_ADDRESS = 0x8c1ba6f0;
        const ASSET_COUNT = 115;
        const OBJECT_COUNT = 46;
        const OBJECTDATA_SIZE = 0x28;
    
        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableSinglesSize(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT, OBJECTDATA_SIZE);
        return { Models, Objects };
    }

    function extractSlice2() {
        const ASSET_TABLE_ADDRESS = 0x8c1bb270;
        const TEXTURE_TABLE_ADDRESS = 0x8c1bb3d0;
        const OBJECT_TABLE_ADDRESS = 0x8c1ba7a8;
        const ASSET_COUNT = 88;
        const OBJECT_COUNT = 46;
        const OBJECTDATA_SIZE = 0x28;

        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableSinglesSize(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT, OBJECTDATA_SIZE);
        return { Models, Objects };
    }

    function extractSlice3() {
        const ASSET_TABLE_ADDRESS = 0x8c1bb530;
        const TEXTURE_TABLE_ADDRESS = 0x8c1bb8ec;
        const OBJECT_TABLE_ADDRESS = 0x8c1ba860;
        const ASSET_COUNT = 239;
        const OBJECT_COUNT = 5;
        const OBJECTDATA_SIZE = 0x34;
    
        const Models = extractModelTable(execBuffer, texChunk.texlists, SCENE_FILE, ASSET_TABLE_ADDRESS, TEXTURE_TABLE_ADDRESS, ASSET_COUNT);
        const Objects = extractObjectTableSinglesSize(execBuffer, SCENE_FILE, OBJECT_TABLE_ADDRESS, OBJECT_COUNT, OBJECTDATA_SIZE);
        return { Models, Objects };
    }

    const slice1 = extractSlice1();
    const slice2 = extractSlice2();
    const slice3 = extractSlice3();

    const crg1 = packStageData(texChunk, [slice1, slice2, slice3]);
    saveStageData(dstFilename, crg1);
}

function main() {
    const exec = fetchDataSync(`${pathBaseIn}/1ST_READ.BIN`);
    extractStage1(`${pathBaseOut}/Stage1.crg1`, exec);
    extractStage2(`${pathBaseOut}/Stage2.crg1`, exec);
    extractStage3(`${pathBaseOut}/Stage3.crg1`, exec);
}

main();
