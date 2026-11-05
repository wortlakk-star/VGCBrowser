// Giá trị gắn lúc build (electron.vite.config.ts → define). Bản bundle test bằng esbuild không có
// chúng → luôn đọc qua src/main/targets.ts (có kiểm tra typeof).
declare const __VGC_TARGET__: string
declare const __VGC_APP_KEY__: string
declare const __VGC_FAKE_ANON__: string
declare const __VGC_TEST__: boolean
