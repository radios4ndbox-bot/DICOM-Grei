'use strict';

/**
 * Worker del viewer: decodifica un fotogramma alla volta, su richiesta.
 * Resta vivo finché la finestra del viewer è aperta, così i moduli wasm dei
 * codec si caricano una volta sola.
 */

const { parentPort } = require('worker_threads');
const { decodeFrame } = require('./dicomDecode');

parentPort.on('message', async (m) => {
  let result;
  try {
    result = await decodeFrame(m.file, m.frame);
  } catch (err) {
    result = { error: 'decodifica', message: String((err && err.message) || err) };
  }
  // i pixel passano di mano senza copia
  const transfer = result && result.pixels ? [result.pixels.buffer] : [];
  parentPort.postMessage({ id: m.id, result }, transfer);
});
