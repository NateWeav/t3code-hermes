import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
// Recolor the official nightly renders so the glass, stars, and cloud geometry stay intact.
const SKY_HUE_ROTATION = 275;
const nightly = "assets/nightly";
const read = (relative) => NodeFSP.readFile(NodePath.join(root, relative));
const recolor = (source) => sharp(source).modulate({ hue: SKY_HUE_ROTATION }).png().toBuffer();
const mark = await read(`${nightly}/app-icon.icon/Assets/text.svg`);
const icon = await recolor(await read(`${nightly}/nightly-universal-1024.png`));
const png = (source, size) => sharp(source).resize(size, size).png().toBuffer();
const write = async (relative, contents) => {
  const target = NodePath.join(root, relative);
  if (check) {
    if (!(await NodeFSP.readFile(target)).equals(contents))
      throw new Error(`Stale icon: ${relative}`);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, contents);
  }
};
await write("assets/hermes/mark.svg", mark);
await write("assets/hermes/icon-1024.png", icon);
await write(
  "assets/hermes/ios-1024.png",
  await recolor(await read(`${nightly}/nightly-ios-1024.png`)),
);
await write(
  "assets/hermes/macos-1024.png",
  await recolor(await read(`${nightly}/nightly-macos-1024.png`)),
);

// Keep the editable Apple layers in the same palette as the rendered exports.
const composerSource = await read(`${nightly}/app-icon.icon/icon.json`);
const composer = JSON.parse(composerSource.toString());
await write("assets/hermes/app-icon.icon/icon.json", composerSource);
const layers = composer.groups.flatMap((group) => group.layers);
const layerSources = new Map();
for (const layer of layers) {
  const name = layer["image-name"];
  const source = (await read(`${nightly}/app-icon.icon/Assets/${name}`)).toString();
  const colors = [...new Set(source.match(/#[0-9a-f]{6}/gi) ?? [])];
  const palette = new Map(
    await Promise.all(
      colors.map(async (color) => {
        const rgb = await sharp({ create: { width: 1, height: 1, channels: 3, background: color } })
          .modulate({ hue: SKY_HUE_ROTATION })
          .raw()
          .toBuffer();
        return [color, `#${rgb.toString("hex")}`];
      }),
    ),
  );
  const recolored = source.replace(/#[0-9a-f]{6}/gi, (color) => palette.get(color));
  layerSources.set(name, recolored);
  await write(`assets/hermes/app-icon.icon/Assets/${name}`, Buffer.from(recolored));
}

// Android supplies its own mask; compose the same sky layers without the T3 foreground.
const backgroundLayers = [];
for (const layer of layers.toReversed()) {
  const name = layer["image-name"];
  if (name === "text.svg" || name === "background.svg") continue;
  const source = layerSources.get(name).replace(/ filter="url\(#soft\)"/, "");
  const width = Math.round(64 * layer.position.scale);
  const height = Math.round(32 * layer.position.scale);
  const [tx, ty] = layer.position["translation-in-points"];
  const left = Math.round(512 + tx - width / 2);
  const top = Math.round(512 + ty - height / 2);
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  const raster = await sharp(Buffer.from(source)).resize(width, height).png().toBuffer();
  backgroundLayers.push({
    input: await sharp(raster)
      .extract({
        left: x - left,
        top: y - top,
        width: Math.min(1024, left + width) - x,
        height: Math.min(1024, top + height) - y,
      })
      .png()
      .toBuffer(),
    left: x,
    top: y,
  });
}
const sky = layerSources.get("background.svg").replace('rx="10"', 'rx="0"');
const background = await sharp(await png(Buffer.from(sky), 1024))
  .composite(backgroundLayers)
  .png()
  .toBuffer();
const renditions = await Promise.all(
  WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await png(icon, size) })),
);
await write("assets/hermes/icon.ico", encodePngIco(renditions));
const favicon = encodePngIco(renditions.filter(({ size }) => size === 16 || size === 32));
for (const directory of ["assets/hermes", "apps/web/public"]) {
  await write(`${directory}/favicon.ico`, favicon);
  for (const size of [16, 32])
    await write(`${directory}/favicon-${size}x${size}.png`, await png(icon, size));
  await write(`${directory}/apple-touch-icon.png`, await png(icon, 180));
}
// Android's adaptive mask crops to its central safe zone.
const foreground = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: "#00000000" },
})
  .composite([{ input: await png(mark, 640), gravity: "centre" }])
  .png()
  .toBuffer();
await write("apps/mobile/assets/android-icon-foreground.png", foreground);
await write("apps/mobile/assets/android-icon-mark.png", foreground);
await write("apps/mobile/assets/android-notification-icon.png", await png(mark, 96));
for (const variant of ["dev", "nightly", "prod"]) {
  await write(`apps/mobile/assets/android-icon-background-${variant}.png`, background);
  await write(
    `apps/mobile/assets/android-splash-icon-${variant}.png`,
    await sharp(background)
      .composite([{ input: foreground }])
      .png()
      .toBuffer(),
  );
}
await write("apps/mobile/assets/widget/T3Mark.svg", mark);
console.log(check ? "Hermes icons are current." : "Exported Hermes icons.");
