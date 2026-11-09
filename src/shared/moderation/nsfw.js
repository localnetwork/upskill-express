import sharp from "sharp";
import * as tf from "@tensorflow/tfjs";
import * as nsfwjs from "nsfwjs";

const MODEL_INPUT_SIZE = 224;
const PORN_HENTAI_THRESHOLD = Number(process.env.NSFW_BLOCK_THRESHOLD || 0.6);
const SEXY_THRESHOLD = Number(process.env.NSFW_SEXY_THRESHOLD || 0.85);

let modelPromise = null;

function getModel() {
  if (!modelPromise) {
    modelPromise = nsfwjs.load().catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

export async function isImageIndecent(buffer) {
  const model = await getModel();
  const { data, info } = await sharp(buffer, { failOn: "none" })
    .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], "int32");
  try {
    const predictions = await model.classify(tensor);
    const score = (name) => predictions.find((item) => item.className === name)?.probability || 0;
    return (
      score("Porn") >= PORN_HENTAI_THRESHOLD ||
      score("Hentai") >= PORN_HENTAI_THRESHOLD ||
      score("Sexy") >= SEXY_THRESHOLD
    );
  } finally {
    tensor.dispose();
  }
}
