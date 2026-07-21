// Vite `?raw` imports return the file's text as a default string export.
declare module "*?raw" {
  const content: string;
  export default content;
}
