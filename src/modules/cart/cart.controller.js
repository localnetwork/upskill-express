import { addToCart, getCart, removeFromCart } from "./cart.service.js";

function pickLatestMediaByTypes(mediaList = [], types = []) {
  return mediaList.find((item) => types.includes(item.mediaType)) || null;
}

function mapLegacyMedia(media) {
  if (!media) return null;
  return {
    id: media.id,
    path: media.storagePath,
    title: media.originalName,
  };
}

function toLegacyCartItem(item) {
  const coverImage = mapLegacyMedia(
    pickLatestMediaByTypes(item.course.media, ["COVER_IMAGE", "IMAGE"]),
  );
  const promoVideo = mapLegacyMedia(
    pickLatestMediaByTypes(item.course.media, ["PROMO_VIDEO"]),
  );

  return {
    id: item.id,
    cart_id: item.courseId,
    cart_item_id: item.id,
    course: {
      id: item.course.id,
      slug: item.course.slug,
      title: item.course.title,
      cover_image: coverImage,
      promo_video: promoVideo,
      price_tier: item.course.priceTier
        ? {
            id: item.course.priceTier.id,
            title: item.course.priceTier.title,
            price: String(item.course.priceTier.price),
          }
        : null,
      author: {
        data: {
          id: item.course.educator?.id,
          username: item.course.educator?.username,
          firstname: item.course.educator?.firstName || item.course.educator?.firstname || "",
          lastname: item.course.educator?.lastName || item.course.educator?.lastname || "",
          user_picture: null,
        },
      },
    },
  };
}

function toLegacyCart(cart) {
  const cartItems = (cart?.items || []).map(toLegacyCartItem);
  const cartTotal = cartItems.reduce((total, item) => {
    const price = Number(item?.course?.price_tier?.price || 0);
    return total + (Number.isNaN(price) ? 0 : price);
  }, 0);

  return {
    cartItems,
    cartTotal: Number(cartTotal.toFixed(2)),
  };
}

export async function getCartController(req, res) {
  const data = await getCart(req.user.id);
  return res.json({ message: "Cart fetched", data: toLegacyCart(data) });
}

export async function getCartCountController(req, res) {
  const data = await getCart(req.user.id);
  return res.json({ count: data?.items?.length || 0 });
}

export async function addToCartController(req, res) {
  const courseId = req.body.courseId || req.body.course_id;
  const data = await addToCart(req.user.id, courseId);
  return res.status(201).json({ message: "Added to cart", data: toLegacyCart(data) });
}

export async function removeFromCartController(req, res) {
  const itemOrCourseId = req.params.courseId || req.params.itemId;
  const data = await removeFromCart(req.user.id, itemOrCourseId);
  return res.json({ message: "Removed from cart", data: toLegacyCart(data) });
}
