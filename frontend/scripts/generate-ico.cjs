const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const icojs = require('icojs');

async function generateICO() {
  const svgPath = path.join(__dirname, '../public/svg/calendar.svg');
  const outputPath = path.join(__dirname, '../public/icons');
  
  console.log('Generating ICO from:', svgPath);
  
  // 读取原始 SVG
  let svgContent = fs.readFileSync(svgPath, 'utf8');
  
  // 修改 SVG 颜色为白色（适配深色模式）
  svgContent = svgContent.replace('fill="#262626"', 'fill="#ffffff"');
  
  // 将修改后的 SVG 写入临时文件
  const tempSvgPath = path.join(outputPath, 'calendar-white-temp.svg');
  fs.writeFileSync(tempSvgPath, svgContent);
  
  // 生成多个尺寸的 PNG
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = [];
  
  for (const size of sizes) {
    const pngBuffer = await sharp(tempSvgPath)
      .resize(size, size)
      .png()
      .toBuffer();
    
    images.push({
      width: size,
      height: size,
      buffer: pngBuffer
    });
    
    console.log(`Added ${size}x${size} to ICO`);
  }
  
  // 生成 ICO 文件
  const icoBuffer = icojs.encode(images);
  const icoPath = path.join(outputPath, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  
  console.log('Generated ICO:', icoPath);
  
  // 清理临时文件
  fs.unlinkSync(tempSvgPath);
  
  console.log('ICO generation completed!');
  console.log('Note: ICO icons are now white for dark mode compatibility');
}

generateICO().catch(console.error);
