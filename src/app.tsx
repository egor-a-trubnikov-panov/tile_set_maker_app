import {render} from "react-dom";
import "./styles.css";
import {useDropzone} from "react-dropzone";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent} from "react";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import c2i from './canvas2image';
import Paper from "@mui/material/Paper";
import {dialog, require as elequire} from '@electron/remote'
import {SnackbarProvider, useSnackbar} from "notistack";
import FormControlLabel from "@mui/material/FormControlLabel";
import Checkbox from "@mui/material/Checkbox";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";

const fs = elequire('fs');
const zoomSteps = [
    {label: '-5%', value: 0.95},
    {label: '-1%', value: 0.99},
    {label: '+1%', value: 1.01},
    {label: '+5%', value: 1.05},
];

interface Size {
    width: number,
    height: number
}

interface Offset {
    x: number,
    y: number
}

interface SliceGrid {
    tileWidth: number,
    tileHeight: number,
    offsetX: number,
    offsetY: number,
    columns: number,
    rows: number,
    startColumn: number,
    startRow: number,
    tiles: SliceTile[],
}

interface SliceTile {
    x: number,
    y: number,
    row: number,
    column: number,
}

const defaultSliceTileSize: Size = {width: 128, height: 64};

const loadImage = (file: File): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onerror = () => reject(reader.error ?? new Error(`Image reading failed: ${file.name}`));
        reader.onload = () => {
            if (typeof reader.result !== 'string') {
                reject(new Error(`Image data is empty: ${file.name}`));
                return;
            }

            const img = new Image();

            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Image loading failed: ${file.name}`));
            img.src = reader.result;
        };

        reader.readAsDataURL(file);
    });
};

const getImageSize = (image: HTMLImageElement): Size => ({
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
});

const getNonNegativeNumber = (value: string): number => Math.max(0, Number(value) || 0);
const getPositiveNumber = (value: string): number => Math.max(1, Number(value) || 1);
const getSignedNumber = (value: string): number => Number(value) || 0;

const drawDiamondPath = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number
): void => {
    context.beginPath();
    context.moveTo(x + width / 2, y);
    context.lineTo(x + width, y + height / 2);
    context.lineTo(x + width / 2, y + height);
    context.lineTo(x, y + height / 2);
    context.closePath();
};

const getSliceGrid = (
    image: HTMLImageElement | null,
    tileSize: Size,
    offset: Offset,
    columns: number,
    rows: number
): SliceGrid => {
    const tileWidth = Math.max(1, tileSize.width);
    const tileHeight = Math.max(1, tileSize.height);
    const offsetX = offset.x;
    const offsetY = offset.y;

    if (!image) {
        return {
            tileWidth,
            tileHeight,
            offsetX,
            offsetY,
            columns: 0,
            rows: 0,
            startColumn: 0,
            startRow: 0,
            tiles: [],
        };
    }

    const imageSize = getImageSize(image);
    const rowStep = tileHeight / 2;
    const startRow = Math.floor((-offsetY - tileHeight) / rowStep) + 1;
    const lastRow = Math.floor((imageSize.height - 1 - offsetY) / rowStep);
    const availableRows = Math.max(0, lastRow - startRow + 1);
    const requestedRows = rows > 0 ? Math.min(rows, availableRows) : availableRows;
    const tiles: SliceTile[] = [];
    let maxColumns = 0;
    let startColumn = 0;

    for (let rowIndex = 0; rowIndex < requestedRows; rowIndex++) {
        const row = startRow + rowIndex;
        const xBase = offsetX + (row % 2 === 0 ? 0 : tileWidth / 2);
        const firstColumn = Math.floor((-xBase - tileWidth) / tileWidth) + 1;
        const lastColumn = Math.floor((imageSize.width - 1 - xBase) / tileWidth);
        const availableColumns = Math.max(0, lastColumn - firstColumn + 1);
        const requestedColumns = columns > 0 ? Math.min(columns, availableColumns) : availableColumns;

        if (rowIndex === 0) {
            startColumn = firstColumn;
        } else {
            startColumn = Math.min(startColumn, firstColumn);
        }

        maxColumns = Math.max(maxColumns, requestedColumns);

        for (let columnIndex = 0; columnIndex < requestedColumns; columnIndex++) {
            const column = firstColumn + columnIndex;
            const x = Math.round(xBase + column * tileWidth);
            const y = Math.round(offsetY + row * rowStep);

            if (x < imageSize.width && y < imageSize.height && x + tileWidth > 0 && y + tileHeight > 0) {
                tiles.push({x, y, row, column});
            }
        }
    }

    return {
        tileWidth,
        tileHeight,
        offsetX,
        offsetY,
        columns: maxColumns,
        rows: requestedRows,
        startColumn,
        startRow,
        tiles,
    };
};

const canvasToImage = (canvas: HTMLCanvasElement): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
        const image = new Image();

        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Canvas image creation failed'));
        image.src = canvas.toDataURL('image/png');
    });
};

const createTileImage = (
    sourceImage: HTMLImageElement,
    sourceX: number,
    sourceY: number,
    tileWidth: number,
    tileHeight: number,
    useDiamondMask: boolean
): Promise<HTMLImageElement> => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    canvas.width = tileWidth;
    canvas.height = tileHeight;

    if (!context) {
        return Promise.reject(new Error('Tile canvas creation failed'));
    }

    context.imageSmoothingEnabled = false;
    const sourceImageSize = getImageSize(sourceImage);
    const sourceRight = sourceX + tileWidth;
    const sourceBottom = sourceY + tileHeight;
    const clippedSourceX = Math.max(0, sourceX);
    const clippedSourceY = Math.max(0, sourceY);
    const clippedSourceRight = Math.min(sourceImageSize.width, sourceRight);
    const clippedSourceBottom = Math.min(sourceImageSize.height, sourceBottom);
    const clippedWidth = clippedSourceRight - clippedSourceX;
    const clippedHeight = clippedSourceBottom - clippedSourceY;

    if (useDiamondMask) {
        context.save();
        drawDiamondPath(context, 0, 0, tileWidth, tileHeight);
        context.clip();
    }

    if (clippedWidth > 0 && clippedHeight > 0) {
        context.drawImage(
            sourceImage,
            clippedSourceX,
            clippedSourceY,
            clippedWidth,
            clippedHeight,
            clippedSourceX - sourceX,
            clippedSourceY - sourceY,
            clippedWidth,
            clippedHeight
        );
    }

    if (useDiamondMask) {
        context.restore();
    }

    return canvasToImage(canvas);
};

const createSlicedTileImages = (
    sourceImage: HTMLImageElement,
    sliceGrid: SliceGrid,
    useDiamondMask: boolean,
    maxTiles?: number
): Promise<HTMLImageElement[]> => {
    const limit = maxTiles ?? sliceGrid.tiles.length;

    return Promise.all(sliceGrid.tiles.slice(0, limit).map((tile) => {
        return createTileImage(
            sourceImage,
            tile.x,
            tile.y,
            sliceGrid.tileWidth,
            sliceGrid.tileHeight,
            useDiamondMask
        );
    }));
};

function App() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const slicerCanvasRef = useRef<HTMLCanvasElement>(null);
    const sliceDragRef = useRef<{ x: number, y: number } | null>(null);

    const [activeTab, setActiveTab] = useState<number>(0);
    const [maxSize, setMaxSize] = useState<Size>({width: 0, height: 0});
    const [space, setSpace] = useState<number>(0);
    const [fileName, setFileName] = useState<string>('tileset');
    const [columnsCount, setColumnsCount] = useState<number>(5);
    const [imagesList, setImagesList] = useState<HTMLImageElement[]>([]);
    const [exportFolderPath, setExportFolderPath] = useState<string>('');
    const [sliceImage, setSliceImage] = useState<HTMLImageElement | null>(null);
    const [sliceTileSize, setSliceTileSize] = useState<Size>(defaultSliceTileSize);
    const [sliceOffset, setSliceOffset] = useState<Offset>({x: 0, y: 0});
    const [sliceColumns, setSliceColumns] = useState<number>(0);
    const [sliceRows, setSliceRows] = useState<number>(0);
    const [useDiamondMask, setUseDiamondMask] = useState<boolean>(false);
    const {enqueueSnackbar} = useSnackbar();

    const sliceGrid = useMemo(() => {
        return getSliceGrid(sliceImage, sliceTileSize, sliceOffset, sliceColumns, sliceRows);
    }, [sliceColumns, sliceImage, sliceOffset, sliceRows, sliceTileSize]);

    const rowsCount = Math.ceil(imagesList.length / columnsCount);
    const totalSliceTiles = sliceGrid.tiles.length;
    const textureFileName = `${fileName}_texture.png`;
    const tilesetFileName = `${fileName}_tileset.json`;

    const onDrop: (files: File[]) => void = useCallback((files) => {
        Promise.all(files.map(loadImage)).then((images) => {
            setMaxSize((currentMaxSize) => {
                return images.reduce((sizes, image) => {
                    const imageSize = getImageSize(image);

                    return {
                        width: Math.max(sizes.width, imageSize.width),
                        height: Math.max(sizes.height, imageSize.height),
                    };
                }, {...currentMaxSize});
            });
            setImagesList(images)
        }).catch(() => {
            enqueueSnackbar('Image loading failed', {variant: 'error'});
        })
    }, [enqueueSnackbar, setMaxSize, setImagesList]);

    const {getRootProps, getInputProps} = useDropzone({
        onDrop
    });

    const onSliceDrop: (files: File[]) => void = useCallback((files) => {
        const file = files[0];

        if (!file) {
            return;
        }

        loadImage(file).then((image) => {
            setSliceImage(image);
            setSliceColumns(0);
            setSliceRows(0);
        }).catch(() => {
            enqueueSnackbar('Image loading failed', {variant: 'error'});
        })
    }, [enqueueSnackbar]);

    const {
        getRootProps: getSliceRootProps,
        getInputProps: getSliceInputProps,
        isDragActive: isSliceDragActive,
    } = useDropzone({
        multiple: false,
        noClick: true,
        onDrop: onSliceDrop
    });

    useEffect(() => {
        if (activeTab === 1) {
            return;
        }

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        let row = 0;
        let col = 0;
        context?.clearRect(0, 0, canvas?.width ?? 0, canvas?.height ?? 0)
        imagesList.forEach((image) => {
            const imageSize = getImageSize(image);
            const x = (maxSize.width + space) * col;
            const y = (maxSize.height + space) * row + (maxSize.height - imageSize.height);
            context?.drawImage(
                image,
                x,
                y,
            );
            if (col === columnsCount - 1) {
                row++
                col = 0
            } else {
                col++
            }
        })
    }, [activeTab, imagesList, space, maxSize, columnsCount])

    useEffect(() => {
        if (activeTab !== 1) {
            return;
        }

        const canvas = slicerCanvasRef.current;

        if (!canvas || !sliceImage) {
            return;
        }

        const context = canvas.getContext('2d');

        if (!context) {
            return;
        }

        const imageSize = getImageSize(sliceImage);
        canvas.width = imageSize.width;
        canvas.height = imageSize.height;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = false;
        context.drawImage(sliceImage, 0, 0);

        if (sliceGrid.tiles.length === 0) {
            return;
        }

        context.save();
        context.lineWidth = Math.max(1, Math.round(Math.min(sliceGrid.tileWidth, sliceGrid.tileHeight) / 64));

        sliceGrid.tiles.forEach((tile) => {
            context.setLineDash([6, 4]);
            context.strokeStyle = 'rgba(255, 255, 255, 0.72)';
            context.strokeRect(tile.x, tile.y, sliceGrid.tileWidth, sliceGrid.tileHeight);

            context.setLineDash([]);
            context.fillStyle = 'rgba(48, 182, 232, 0.08)';
            context.strokeStyle = 'rgba(48, 182, 232, 0.95)';
            drawDiamondPath(context, tile.x, tile.y, sliceGrid.tileWidth, sliceGrid.tileHeight);
            context.fill();
            context.stroke();
        });

        context.restore();
    }, [activeTab, sliceGrid, sliceImage])

    const handleClear = useCallback(() => {
        setImagesList([])
        setMaxSize({width: 0, height: 0})
    }, [setMaxSize, setImagesList])

    const handleSlice = useCallback((replaceTiles: boolean) => {
        if (!sliceImage || sliceGrid.tiles.length === 0) {
            return;
        }

        createSlicedTileImages(sliceImage, sliceGrid, useDiamondMask).then((images) => {
            setImagesList((currentImages) => replaceTiles ? images : [...currentImages, ...images]);
            setMaxSize((currentMaxSize) => {
                if (replaceTiles) {
                    return {
                        width: sliceGrid.tileWidth,
                        height: sliceGrid.tileHeight,
                    };
                }

                return {
                    width: Math.max(currentMaxSize.width, sliceGrid.tileWidth),
                    height: Math.max(currentMaxSize.height, sliceGrid.tileHeight),
                };
            });
            setColumnsCount(Math.max(1, replaceTiles ? sliceGrid.columns : columnsCount));
            enqueueSnackbar(`Tiles sliced: ${images.length}`, {variant: 'success'});
        }).catch(() => {
            enqueueSnackbar('Tile slicing failed', {variant: 'error'});
        })
    }, [columnsCount, enqueueSnackbar, sliceGrid, sliceImage, useDiamondMask])

    const handleSlicePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        event.stopPropagation();
        sliceDragRef.current = {x: event.clientX, y: event.clientY};
        event.currentTarget.setPointerCapture(event.pointerId);
    }, [])

    const handleSlicePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
        const lastPoint = sliceDragRef.current;
        const canvas = event.currentTarget;

        if (!lastPoint) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const bounds = canvas.getBoundingClientRect();
        const scaleX = canvas.width / bounds.width;
        const scaleY = canvas.height / bounds.height;
        const x = Math.round((event.clientX - lastPoint.x) * scaleX);
        const y = Math.round((event.clientY - lastPoint.y) * scaleY);

        if (x !== 0 || y !== 0) {
            setSliceOffset((currentOffset) => ({
                x: currentOffset.x + x,
                y: currentOffset.y + y,
            }));
            sliceDragRef.current = {x: event.clientX, y: event.clientY};
        }
    }, [])

    const handleSlicePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        event.stopPropagation();
        sliceDragRef.current = null;
    }, [])

    const handleSliceWheel = useCallback((event: ReactWheelEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        event.stopPropagation();

        const scale = event.deltaY < 0 ? 1.02 : 0.98;

        setSliceTileSize((currentTileSize) => ({
            width: Math.max(1, Math.round(currentTileSize.width * scale)),
            height: Math.max(1, Math.round(currentTileSize.height * scale)),
        }));
    }, [])

    const handleSliceZoom = useCallback((scale: number) => {
        setSliceTileSize((currentTileSize) => ({
            width: Math.max(1, Math.round(currentTileSize.width * scale)),
            height: Math.max(1, Math.round(currentTileSize.height * scale)),
        }));
    }, [])

    const handleChooseExportFolder = useCallback(() => {
        dialog.showOpenDialog({properties: ['openDirectory']}).then((directory) => {
            if (directory.canceled || directory.filePaths.length === 0) {
                return;
            }

            setExportFolderPath(directory.filePaths[0]);
        })
    }, [])

    const handleExport = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || imagesList.length === 0 || !exportFolderPath) {
            return;
        }

        const img = c2i.convertToPNG(canvas, canvas.width, canvas.height)
        const base64Image = img.src.split(';base64,').pop();
        if (!base64Image) {
            enqueueSnackbar(`Error: ${textureFileName}`, {variant: 'error'});
            return;
        }

        const tileDescription = {
            "columns": columnsCount,
            "image": textureFileName,
            "imageheight": (maxSize.height + space) * rowsCount,
            "imagewidth": (maxSize.width + space) * columnsCount,
            "margin": 0,
            "name": `${fileName}_tileset`,
            "spacing": space,
            "tilecount": imagesList.length,
            "tiledversion": "1.7.2",
            "tileheight": maxSize.height,
            "tilewidth": maxSize.width,
            "type": "tileset",
            "version": "1.6"
        }

        fs.writeFile(`${exportFolderPath}/${textureFileName}`, base64Image, {encoding: 'base64'}, (err: unknown) => {
            if (!err) {
                enqueueSnackbar(`File created: ${textureFileName}`, {variant: 'success'});
            } else {
                enqueueSnackbar(`Error: ${textureFileName}`, {variant: 'error'});
            }
        });
        fs.writeFile(`${exportFolderPath}/${tilesetFileName}`, JSON.stringify(tileDescription), (err: unknown) => {
            if (!err) {
                enqueueSnackbar(`File created: ${tilesetFileName}`, {variant: 'success'});
            } else {
                enqueueSnackbar(`Error: ${tilesetFileName}`, {variant: 'error'});
            }
        })
    }, [
        columnsCount,
        enqueueSnackbar,
        exportFolderPath,
        fileName,
        imagesList.length,
        maxSize,
        rowsCount,
        space,
        textureFileName,
        tilesetFileName
    ])

    return (
        <div className="App">
            <div className="canvasWrapper">
                {activeTab === 1 ? (
                    <Paper {...getSliceRootProps({
                        className: `workspaceDrop ${isSliceDragActive ? 'workspaceDropActive' : ''}`
                    })}>
                        <input {...getSliceInputProps()} />
                        {sliceImage ? (
                            <canvas className="sliceWorkspaceCanvas"
                                    ref={slicerCanvasRef}
                                    onPointerDown={handleSlicePointerDown}
                                    onPointerMove={handleSlicePointerMove}
                                    onPointerUp={handleSlicePointerUp}
                                    onPointerCancel={handleSlicePointerUp}
                                    onWheel={handleSliceWheel}/>
                        ) : (
                            <span>Drop source image</span>
                        )}
                    </Paper>
                ) : (
                    <canvas width={columnsCount * (maxSize.width + space)}
                            height={rowsCount * (maxSize.height + space)}
                            className="canvas" ref={canvasRef}/>
                )}
            </div>
            <div className="tools">
                <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value)} variant="fullWidth">
                    <Tab label="Tileset"/>
                    <Tab label="Slice"/>
                    <Tab label="Export"/>
                </Tabs>

                {activeTab === 0 && (
                    <section className="tabPanel">
                        <div className="fieldGrid">
                            <TextField type="number" label='width' value={maxSize.width} onChange={(e) => {
                                setMaxSize(old => ({...old, width: getNonNegativeNumber(e.target.value)}))
                            }}/>
                            <TextField type="number" label='height' value={maxSize.height} onChange={(e) => {
                                setMaxSize(old => ({...old, height: getNonNegativeNumber(e.target.value)}))
                            }}/>
                            <TextField type="number" label='space' value={space} onChange={(e) => {
                                setSpace(getNonNegativeNumber(e.target.value))
                            }}/>
                            <TextField type="number" label='columns' value={columnsCount} onChange={(e) => {
                                setColumnsCount(getPositiveNumber(e.target.value))
                            }}/>
                        </div>
                        <Paper {...getRootProps()} className="fileDropp">
                            {imagesList.map((img) => (
                                <img src={img.src} key={img.src} title={`${img.width}x${img.height}`}/>
                            ))}
                            <input {...getInputProps()} />
                        </Paper>
                        <div className="sliceStats">
                            {imagesList.length} tiles / {columnsCount} columns / {rowsCount} rows
                        </div>
                        <div className="singleButton">
                            <Button variant="outlined" onClick={handleClear}>Clear</Button>
                        </div>
                    </section>
                )}

                {activeTab === 1 && (
                    <section className="tabPanel">
                        <div className="fieldGrid">
                            <TextField type="number" label='tile width' value={sliceTileSize.width} onChange={(e) => {
                                setSliceTileSize(old => ({...old, width: getPositiveNumber(e.target.value)}))
                            }}/>
                            <TextField type="number" label='tile height' value={sliceTileSize.height} onChange={(e) => {
                                setSliceTileSize(old => ({...old, height: getPositiveNumber(e.target.value)}))
                            }}/>
                            <TextField type="number" label='grid shift x' value={sliceOffset.x} onChange={(e) => {
                                setSliceOffset(old => ({...old, x: getSignedNumber(e.target.value)}))
                            }}/>
                            <TextField type="number" label='grid shift y' value={sliceOffset.y} onChange={(e) => {
                                setSliceOffset(old => ({...old, y: getSignedNumber(e.target.value)}))
                            }}/>
                            <TextField type="number" label='columns' value={sliceColumns} onChange={(e) => {
                                setSliceColumns(getNonNegativeNumber(e.target.value))
                            }}/>
                            <TextField type="number" label='rows' value={sliceRows} onChange={(e) => {
                                setSliceRows(getNonNegativeNumber(e.target.value))
                            }}/>
                        </div>
                        <div className="zoomButtons">
                            {zoomSteps.map((step) => (
                                <Button key={step.label} variant="outlined" onClick={() => handleSliceZoom(step.value)}>
                                    {step.label}
                                </Button>
                            ))}
                        </div>
                        <FormControlLabel control={(
                            <Checkbox checked={useDiamondMask} onChange={(e) => {
                                setUseDiamondMask(e.target.checked)
                            }}/>
                        )} label="diamond mask"/>
                        <div className="sliceStats">
                            {sliceGrid.columns} x {sliceGrid.rows} / {totalSliceTiles} tiles
                        </div>
                        <div className="buttons">
                            <Button variant="outlined" disabled={!sliceImage || sliceGrid.tiles.length === 0}
                                    onClick={() => handleSlice(false)}>Slice Append</Button>
                            <Button variant="contained" disabled={!sliceImage || sliceGrid.tiles.length === 0}
                                    onClick={() => handleSlice(true)}>Slice Replace</Button>
                        </div>
                    </section>
                )}

                {activeTab === 2 && (
                    <section className="tabPanel">
                        <TextField type="text" label='filename' value={fileName} onChange={(e) => {
                            setFileName(e.target.value)
                        }}/>
                        <TextField label='folder' value={exportFolderPath} inputProps={{readOnly: true}}/>
                        <div className="singleButton">
                            <Button variant="outlined" onClick={handleChooseExportFolder}>Choose folder</Button>
                        </div>
                        <div className="exportSummary">
                            <div>{exportFolderPath ? `${exportFolderPath}/${textureFileName}` : textureFileName}</div>
                            <div>{exportFolderPath ? `${exportFolderPath}/${tilesetFileName}` : tilesetFileName}</div>
                        </div>
                        <Button variant="contained" disabled={imagesList.length === 0 || !exportFolderPath}
                                onClick={handleExport}>Export</Button>
                    </section>
                )}
            </div>
        </div>
    );
}

const rootElement = document.getElementById("root");
render(<SnackbarProvider maxSnack={3}><App/></SnackbarProvider>, rootElement);
