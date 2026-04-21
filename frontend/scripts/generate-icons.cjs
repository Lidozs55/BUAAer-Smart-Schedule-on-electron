const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function generateIcons() {
  const svgPath = path.join(__dirname, '../public/svg/calendar.svg');
  const outputPath = path.join(__dirname, '../public/icons');
  
  // 确保输出目录存在
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }
  
  console.log('Generating icons from:', svgPath);
  
  // 读取原始 SVG
  let svgContent = fs.readFileSync(svgPath, 'utf8');
  
  // 修改 SVG 颜色为白色（适配深色模式）
  // 也可以根据需求设置为其他颜色
  svgContent = svgContent.replace('fill="#262626"', 'fill="#ffffff"');
  
  // 将修改后的 SVG 写入临时文件
  const tempSvgPath = path.join(outputPath, 'calendar-white.svg');
  fs.writeFileSync(tempSvgPath, svgContent);
  
  // 生成不同尺寸的 PNG 图标
  const sizes = [16, 32, 48, 64, 128, 256, 512];
  
  for (const size of sizes) {
    const pngPath = path.join(outputPath, `icon-${size}x${size}.png`);
    await sharp(tempSvgPath)
      .resize(size, size)
      .png()
      .toFile(pngPath);
    console.log(`Generated ${size}x${size} PNG:`, pngPath);
  }
  
  // 生成 256x256 的 PNG 用于系统托盘
  const trayPngPath = path.join(outputPath, 'tray-icon.png');
  await sharp(tempSvgPath)
    .resize(256, 256)
    .png()
    .toFile(trayPngPath);
  console.log('Generated tray icon:', trayPngPath);
  
  // 清理临时文件
  fs.unlinkSync(tempSvgPath);
  
  console.log('Icon generation completed!');
  console.log('Note: Icons are now white for dark mode compatibility');
}

generateIcons().catch(console.error);
