const cloudinary = require('cloudinary').v2;
const config     = require('../config/config');

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key:    config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
});

/**
 * Sube un buffer a Cloudinary.
 * @param {Buffer} buffer
 * @param {string} folder
 * @param {string} mimetype
 * @returns {Promise<{url: string, publicId: string}>}
 */
const uploadToCloudinary = (buffer, folder, mimetype) => {
  const resourceType = mimetype === 'application/pdf' ? 'raw' : 'image';

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, use_filename: false },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
};

/**
 * Elimina un asset de Cloudinary por public_id.
 * No lanza error si ya no existe (silencioso).
 */
const deleteFromCloudinary = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch {
    // Silencioso — puede que el archivo ya no exista
  }
};

module.exports = { uploadToCloudinary, deleteFromCloudinary };
