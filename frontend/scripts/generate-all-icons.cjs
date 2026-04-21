const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const icojs = require('icojs');

async function generateAllIcons() {
  const svgPath = path.join(__dirname, '../public/svg/calendar.svg');
  const outputPath = path.join(__dirname, '../public/icons');
  
  // 确保输出目录存在
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }
  
  console.log('Generating all icons from:', svgPath);
  
  // 读取原始 SVG
  let svgContent = fs.readFileSync(svgPath, 'utf8');
  
  // 生成深色模式图标（白色）
  console.log('\n=== Generating Dark Mode Icons (White) ===');
  let darkModeSvg = svgContent.replace('fill="#262626"', 'fill="#ffffff"');
  const darkModeSvgPath = path.join(outputPath, 'calendar-dark.svg');
  fs.writeFileSync(darkModeSvgPath, darkModeSvg);
  
  await generatePngIcons(darkModeSvgPath, outputPath, 'dark');
  await generateIcoFile(darkModeSvgPath, outputPath, 'dark');
  
  // 生成浅色模式图标（深灰色）
  console.log('\n=== Generating Light Mode Icons (Dark Gray) ===');
  let lightModeSvg = svgContent.replace('fill="#262626"', 'fill="#333333"');
  const lightModeSvgPath = path.join(outputPath, 'calendar-light.svg');
  fs.writeFileSync(lightModeSvgPath, lightModeSvg);
  
  await generatePngIcons(lightModeSvgPath, outputPath, 'light');
  await generateIcoFile(lightModeSvgPath, outputPath, 'light');
  
  // 清理临时文件
  fs.unlinkSync(darkModeSvgPath);
  fs.unlinkSync(lightModeSvgPath);
  
  console.log('\n✅ All icons generation completed!');
  console.log('Dark mode icons: white color (#ffffff)');
  console.log('Light mode icons: dark gray color (#333333)');
}

async function generatePngIcons(svgPath, outputPath, mode) {
  const sizes = [16, 32, 48, 64, 128, 256, 512];
  
  for (const size of sizes) {
    const pngPath = path.join(outputPath, `icon-${mode}-${size}x${size}.png`);
    await sharp(svgPath)
      .resize(size, size)
      .png()
      .toFile(pngPath);
    console.log(`  Generated ${mode} ${size}x${size} PNG`);
  }
  
  // 生成托盘图标
  const trayPngPath = path.join(outputPath, `tray-icon-${mode}.png`);
  await sharp(svgPath)
    .resize(256, 256)
    .png()
    .toFile(trayPngPath);
  console.log(`  Generated ${mode} tray icon`);
}

async function generateIcoFile(svgPath, outputPath, mode) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = [];
  
  for (const size of sizes) {
    const pngBuffer = await sharp(svgPath)
      .resize(size, size)
      .png()
      .toBuffer();
    
    images.push({
      width: size,
      height: size,
      buffer: pngBuffer
    });
  }
  
  const icoBuffer = icojs.encode(images);
  const icoPath = path.join(outputPath, `icon-${mode}.ico`);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`  Generated ${mode} ICO file`);
}

generateAllIcons().catch(console.error);
