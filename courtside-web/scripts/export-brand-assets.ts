import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "public", "brand");
const app = path.join(root, "app");

const svg = (name: string) => path.join(brand, name);
const png = (name: string) => path.join(brand, name);

async function favicon(input: string, sizes: number[]): Promise<Buffer> {
  const images = await Promise.all(sizes.map((size) => sharp(input).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map((image, i) => {
    const size = sizes[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images]);
}

await Promise.all([
  sharp(svg("courtside-app-icon.svg")).resize(192, 192).png().toFile(png("courtside-app-icon-192.png")),
  sharp(svg("courtside-app-icon.svg")).resize(512, 512).png().toFile(png("courtside-app-icon-512.png")),
  sharp(svg("courtside-app-icon.svg")).resize(512, 512).png().toFile(png("courtside-app-icon-maskable-512.png")),
  sharp(svg("courtside-app-icon.svg")).resize(180, 180).png().toFile(path.join(app, "apple-icon.png")),
  sharp(svg("courtside-mark.svg")).resize(512, 512).png().toFile(png("courtside-mark-512.png")),
  sharp(svg("courtside-lockup-dark.svg")).resize({ width: 600 }).png().toFile(png("courtside-lockup-dark-600.png")),
  sharp(svg("courtside-lockup-light.svg")).resize({ width: 600 }).png().toFile(png("courtside-lockup-light-600.png")),
  sharp(svg("courtside-social-card.svg")).png().toFile(png("courtside-social-card.png")),
  sharp(svg("courtside-ci-board.svg")).png().toFile(png("courtside-ci-board.png")),
]);

await writeFile(
  path.join(app, "favicon.ico"),
  await favicon(svg("courtside-app-icon.svg"), [16, 32, 48, 64, 128, 256]),
);

console.log("코트사이드 브랜드 PNG 9개와 favicon.ico를 내보냈습니다.");
