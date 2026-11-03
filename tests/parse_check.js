// 判据：把 web 下的脚本按浏览器 <script> 的语义编译一遍。
// 🔴 为什么单独要这一条：`node --check` 把 .js 当 CommonJS，**顶层 return 是合法的**，
//   而浏览器里它是一句 SyntaxError —— 一旦踩到，整个文件一行都不执行，
//   症状却是「界面能打开、点了没反应、控制台安静得可怕」（2026-11-03 W7 就这么
//   把一版坏 APK 打出来了：校历空态那段被贴到了函数外面）。
// vm.Script 不包 CommonJS，语义和浏览器一致，所以用它编译。
const vm = require('vm');
const fs = require('fs');
const files = process.argv.slice(2);
if (!files.length) files.push('web/app.js', 'web/native.js');
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.Script(src, { filename: f });
    console.log('[parse] OK   ' + f);
  } catch (e) {
    bad++;
    const where = ((e.stack || '').split('\n').find((l) => l.indexOf(f) >= 0) || '').trim();
    console.log('[parse] FAIL ' + f + ' :: ' + e.message + (where ? '  @ ' + where : ''));
  }
}
console.log(bad ? '== 有文件编译不过 ==' : '== 全部通过 ==');
process.exit(bad ? 1 : 0);
