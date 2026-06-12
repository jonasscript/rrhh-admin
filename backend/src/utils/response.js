const success = (res, data, statusCode = 200, message = 'OK') =>
  res.status(statusCode).json({ success: true, message, data });

const paginated = (res, data, total, page, limit) =>
  res.status(200).json({
    success: true,
    data,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  });

module.exports = { success, paginated };
