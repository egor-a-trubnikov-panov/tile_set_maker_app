import {render} from "react-dom";
import "./styles.css";
import {useDropzone} from "react-dropzone";
import {useCallback, useEffect, useRef, useState} from "react";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import c2i from './canvas2image';
import Paper from "@mui/material/Paper";
import {dialog, require as elequire} from '@electron/remote'
import {SnackbarProvider, useSnackbar} from "notistack";

const fs = elequire('fs');

interface Size {
    width: number,
    height: number
}

function App() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const [maxSize, setMaxSize] = useState<Size>({width: 0, height: 0});
    const [space, setSpace] = useState<number>(0);
    const [fileName, setFileName] = useState<string>('tileset');
    const [columnsCount, setColumnsCount] = useState<number>(5);
    const [imagesList, setImagesList] = useState<HTMLImageElement[]>([]);
    const {enqueueSnackbar} = useSnackbar();

    const onDrop: (files: File[]) => void = useCallback((files) => {
        const images: Promise<HTMLImageElement>[] = files.map((file) => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.readAsDataURL(file);
                reader.onload = () => {
                    const img = new Image();
                    img.src = reader.result as string;
                    resolve(img)
                };
            })
        });

        Promise.all(images).then((images) => {
            const sizes = maxSize;
            images.forEach((image) => {
                if (sizes.width < image.width) {
                    sizes.width = image.width;
                }
                if (sizes.height < image.height) {
                    sizes.height = image.height;
                }
            })
            setMaxSize(sizes);
            setImagesList(images)
        })
    }, [maxSize, setMaxSize, setImagesList]);

    const {getRootProps, getInputProps} = useDropzone({
        onDrop
    });

    useEffect(() => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        let row = 0;
        let col = 0;
        context?.clearRect(0, 0, canvas?.width ?? 0, canvas?.height ?? 0)
        imagesList.forEach((image) => {
            const x = (maxSize.width + space) * col;
            const y = (maxSize.height + space) * row + (maxSize.height - image.height);
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
    }, [imagesList, space, maxSize, columnsCount])

    const handleClear = useCallback(() => {
        setImagesList([])
        setMaxSize({width: 0, height: 0})
    }, [setMaxSize, setImagesList])

    const handleExport = useCallback(() => {
        const canvas: HTMLCanvasElement = canvasRef.current;
        const img = c2i.convertToPNG(canvas, canvas.width, canvas.height)
        const base64Image = img.src.split(';base64,').pop();
        const rows = Math.ceil(imagesList.length / columnsCount);

        const tileDescription = {
            "columns": columnsCount,
            "image": `${fileName}_texture.png`,
            "imageheight": (maxSize.height + space) * rows,
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

        dialog.showOpenDialog({properties: ['openDirectory']}).then(async (directory) => {
            fs.writeFile(`${directory.filePaths[0]}/${fileName}_texture.png`, base64Image, {encoding: 'base64'}, (err: unknown) => {
                if (!err) {
                    enqueueSnackbar(`File created: ${fileName}_texture.png`, {variant: 'success'});
                } else {
                    enqueueSnackbar(`Error: ${fileName}_texture.png`, {variant: 'error'});
                }
            });
            fs.writeFile(`${directory.filePaths[0]}/${fileName}_tileset.json`, JSON.stringify(tileDescription), (err: unknown) => {
                if (!err) {
                    enqueueSnackbar(`File created: ${fileName}_tileset.json`, {variant: 'success'});
                } else {
                    enqueueSnackbar(`Error: ${fileName}_tileset.json`, {variant: 'error'});
                }
            })
        })
    }, [fileName, space, maxSize])

    return (
        <div className="App">
            <div className="canvasWrapper">
                <canvas width={columnsCount * (maxSize.width + space)}
                        height={Math.ceil(imagesList.length / columnsCount) * (maxSize.height + space)}
                        className="canvas" ref={canvasRef}/>
            </div>
            <div className="tools">
                <TextField type="text" label='filename' value={fileName} onChange={(e) => {
                    setFileName(e.target.value)
                }}/>
                <TextField type="number" label='width' value={maxSize.width} onChange={(e) => {
                    setMaxSize(old => ({...old, width: Number(e.target.value)}))
                }}/>
                <TextField type="number" label='height' value={maxSize.height} onChange={(e) => {
                    setMaxSize(old => ({...old, height: Number(e.target.value)}))
                }}/>
                <TextField type="number" label='space' value={space} onChange={(e) => {
                    setSpace(Number(e.target.value))
                }}/>

                <TextField type="number" label='columns' value={columnsCount} onChange={(e) => {
                    setColumnsCount(Number(e.target.value))
                }}/>
                <Paper {...getRootProps()} className="fileDropp">
                    {imagesList.map((img) => (
                        <img src={img.src} key={img.src} title={`${img.width}x${img.height}`}/>
                    ))}
                    <input {...getInputProps()} />
                </Paper>
                <div className="buttons">
                    <Button variant="outlined" onClick={handleClear}>Clear</Button>
                    <Button variant="contained" onClick={handleExport}>Export</Button>
                </div>
            </div>
        </div>
    );
}

const rootElement = document.getElementById("root");
render(<SnackbarProvider maxSnack={3}><App/></SnackbarProvider>, rootElement);

