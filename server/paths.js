import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 使用者設定的存放位置(I/O 對映、上次的場景)。
 *
 * 開發時就在專案的 config/。發佈包裡程式本體被塞進 app\ 底下一層,
 * 設定跟著放會變成 app\config\ —— 學員找不到,升級換個資料夾就丟了。
 * 所以啟動腳本會用 SIM_CONFIG 把它指到發佈包根目錄,和 README 放在一起。
 */
export const CONFIG_DIR = process.env.SIM_CONFIG
  ? path.resolve(process.env.SIM_CONFIG)
  : path.resolve(__dirname, '../config');
