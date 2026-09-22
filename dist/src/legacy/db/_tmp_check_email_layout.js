"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const forkup_email_layout_js_1 = require("../lib/forkup-email-layout.js");
const html = (0, forkup_email_layout_js_1.wrapForkUpEmailHtml)({
    subject: "test",
    bodyText: "Hi\n\nReview and respond here:\nhttp://localhost:3000/?step=x&token=abc\n\n— ForkUp",
});
const n = (html.match(/localhost:3000/g) || []).length;
console.log("localhost mentions", n);
console.log("Review line", html.includes("Review and respond"));
console.log("amp in href bad", /href="[^"]*&amp;token/.test(html));
console.log("good href", html.includes('href="http://localhost:3000/?step=x&amp;token=abc"'));
//# sourceMappingURL=_tmp_check_email_layout.js.map