// The speech model never touches images. transformers.js requires "sharp" to exist in Node, so the
// build aliases it to this stand-in instead of shipping a native image library.
export default function sharp(): never {
  throw new Error('Image processing is not part of this app.');
}
