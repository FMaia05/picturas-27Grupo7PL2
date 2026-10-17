const User = require('../models/user');
const limit = Number(process.env.FREE_DAILY_OP || 5);
// Same day key as the existing routes (UTC date components, service local midnight).
// Compose runs users in UTC; do not change the timezone of an existing deployment.
function quotaDay(now = new Date()) {
  return new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
function used(day) {
  return { $sum: { $map: { input: { $filter: { input: '$operations', as: 'o', cond: { $eq: ['$$o.day', day] } } }, as: 'o', in: '$$o.processed' } } };
}
function operations(day, delta) {
  return { $concatArrays: [
    { $filter: { input: '$operations', as: 'o', cond: { $ne: ['$$o.day', day] } } },
    ...(delta < 0 ? [{ $cond: [
      { $gt: [{ $add: [used(day), delta] }, 0] },
      [{ day, processed: { $add: [used(day), delta] } }], [],
    ] }] : [[{ day, processed: { $add: [used(day), delta] } }]]),
  ] };
}
async function charge(userId, count) {
  if (!Number.isSafeInteger(count) || count < 0) return false;
  const day = quotaDay();
  // Legacy check_process always allowed zero-cost operations, including after
  // downgrading a Premium account whose current-day usage exceeds the free limit.
  const permitted = count === 0
    ? { type: { $in: ['anonymous', 'free', 'premium'] } }
    : { $or: [{ type: 'premium' }, { type: 'free', $expr: { $lte: [{ $add: [used(day), count] }, limit] } }] };
  return Boolean(await User.findOneAndUpdate({ _id: userId, ...permitted },
    [{ $set: { operations: operations(day, count) } }], { new: true }));
}
async function refund(userId, count) {
  const user = await User.findById(userId);
  if (!user) return false;
  if (user.type === 'premium') return true;
  await User.updateOne({ _id: userId }, [{ $set: { operations: operations(quotaDay(), -count) } }]);
  return true;
}
async function reserve(userId, id) {
  const previous = await User.findOne({ _id: userId, 'conversionReservations.id': id }).lean();
  if (previous) return previous.conversionReservations.find(r => r.id === id);
  const day = quotaDay();
  const receipt = { id, day, state: 'reserved' };
  const updated = await User.findOneAndUpdate({ _id: userId, 'conversionReservations.id': { $ne: id },
    $or: [{ type: 'premium' }, { type: 'free', $expr: { $lt: [used(day), limit] } }],
  }, [{ $set: {
    operations: { $cond: [{ $eq: ['$type', 'free'] }, operations(day, 1), '$operations'] },
    conversionReservations: { $concatArrays: [{ $ifNull: ['$conversionReservations', []] }, [{ ...receipt, charged: { $eq: ['$type', 'free'] }, userType: '$type' }]] },
  } }], { new: true });
  if (updated) return updated.conversionReservations.find(r => r.id === id).toObject();
  const concurrent = await User.findOne({ _id: userId, 'conversionReservations.id': id }).lean();
  return concurrent?.conversionReservations.find(r => r.id === id) || null;
}
async function settle(userId, id, action) {
  const user = await User.findOne({ _id: userId, 'conversionReservations.id': id }).lean();
  const receipt = user?.conversionReservations.find(r => r.id === id);
  // Releasing an unknown reservation leaves a tombstone: a late reserve cannot debit.
  if (!receipt && action === 'release') {
    const tombstone = await User.updateOne({ _id: userId, 'conversionReservations.id': { $ne: id } }, {
      $push: { conversionReservations: { id, day: quotaDay(), state: 'released', charged: false, userType: user?.type || 'free' } },
    });
    if (!tombstone.modifiedCount) {
      const exists = await User.exists({ _id: userId });
      return exists ? settle(userId, id, action) : true;
    }
    return true;
  }
  if (!receipt) return false;
  if (receipt.state === 'released') return action === 'release';
  if (action === 'confirm' && receipt.state === 'confirmed') return true;
  const next = action === 'confirm' ? 'confirmed' : 'released';
  const updated = await User.updateOne({ _id: userId, conversionReservations: { $elemMatch: { id, state: receipt.state } } }, [{ $set: {
    operations: action === 'release' && receipt.charged ? operations(receipt.day, -1) : '$operations',
    conversionReservations: { $map: { input: '$conversionReservations', as: 'r', in: { $cond: [{ $eq: ['$$r.id', id] }, { $mergeObjects: ['$$r', { state: next }] }, '$$r'] } } },
  } }]);
  if (updated.modifiedCount) return true;
  return settle(userId, id, action);
}
module.exports = { charge, refund, reserve, settle, quotaDay };
