import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

export default createCodemodeExtension({ mode: process.env.CYBERDECK_CODEMODE, models: false });
