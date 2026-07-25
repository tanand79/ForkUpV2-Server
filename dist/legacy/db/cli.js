"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDirectRun = isDirectRun;
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
function isDirectRun(moduleUrl) {
    const entry = process.argv[1];
    if (!entry)
        return false;
    const resolved = path_1.default.resolve(entry).replace(/\\/g, "/").toLowerCase();
    const self = (0, url_1.fileURLToPath)(moduleUrl).replace(/\\/g, "/").toLowerCase();
    return resolved === self;
}
//# sourceMappingURL=cli.js.map