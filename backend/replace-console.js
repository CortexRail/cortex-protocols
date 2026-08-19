const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');

function traverse(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      traverse(filePath);
    } else if (file.endsWith('.js')) {
      if (filePath.includes('utils\\logger.js') || filePath.includes('middleware\\logger.js')) continue;

      let content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('console.log') || content.includes('console.warn') || content.includes('console.error')) {
        let newContent = content;
        newContent = newContent.replace(/console\.log/g, 'logger.info');
        newContent = newContent.replace(/console\.warn/g, 'logger.warn');
        newContent = newContent.replace(/console\.error/g, 'logger.error');
        
        const relDir = path.relative(path.dirname(filePath), path.join(srcDir, 'utils'));
        const loggerImportPath = (relDir.startsWith('.') ? relDir : './' + relDir).replace(/\\/g, '/') + '/logger';
        
        const requireStmt = `const { logger } = require("${loggerImportPath}");`;
        
        const lines = newContent.split(/\r?\n/);
        let lastRequireIndex = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('require(')) {
            lastRequireIndex = i;
          }
        }
        
        if (lastRequireIndex >= 0) {
          lines.splice(lastRequireIndex + 1, 0, requireStmt);
          newContent = lines.join('\n');
        } else {
          newContent = requireStmt + '\n' + newContent;
        }

        fs.writeFileSync(filePath, newContent, 'utf8');
      }
    }
  }
}

traverse(srcDir);
