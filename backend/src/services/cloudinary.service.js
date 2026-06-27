const cloudinary = require('cloudinary').v2;
const { randomUUID } = require('crypto');
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
 * @param {string} originalFilename
 * @returns {Promise<{url: string, publicId: string}>}
 */
const uploadToCloudinary = (buffer, folder, mimetype, originalFilename = 'comprobante') => {
  const isPdf = mimetype === 'application/pdf';
  const options = {
    folder,
    // Cloudinary clasifica los PDFs como recursos de imagen. Esto genera una
    // URL PDF utilizable en el visor; `raw` preserva bytes, pero no admite
    // transformaciones ni la misma entrega orientada a visualización.
    resource_type: 'image',
    use_filename: false,
  };

  if (isPdf) {
    const baseName = String(originalFilename)
      .replace(/\.pdf$/i, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'comprobante';
    const fileName = `${baseName}-${randomUUID()}`;
    options.public_id = fileName;
    options.format = 'pdf';
    options.filename_override = `${fileName}.pdf`;
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
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
  for (const resourceType of ['image', 'raw']) {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
    } catch {
      // Silencioso — puede que el archivo ya no exista o sea de otro tipo.
    }
  }
};

module.exports = { uploadToCloudinary, deleteFromCloudinary };
