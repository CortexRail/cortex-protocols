import {
  ASSET_TYPES,
  LICENSE_TYPES,
  NAME_MAX,
  DESCRIPTION_MAX,
} from "./constants";
import { xlmToStroops } from "./stroops";

export interface ListingFormValues {
  name: string;
  description: string;
  assetType: string;
  licenseType: string;
  priceXlm: string;
}

export type ListingField = keyof ListingFormValues;
export type FieldErrors = Partial<Record<ListingField, string>>;

export interface ValidationResult {
  valid: boolean;
  errors: FieldErrors;
  /** Price in stroops, only present when the price field is valid. */
  priceStroops?: bigint;
}

/**
 * Client-side validation that mirrors the backend rules
 * (backend/src/routes/stellar.js + assetService.js) and the on-chain
 * constraints (price > 0). Returns per-field messages for inline display.
 */
export function validateListing(values: ListingFormValues): ValidationResult {
  const errors: FieldErrors = {};

  const name = values.name.trim();
  if (name.length === 0) {
    errors.name = "Name is required.";
  } else if (name.length > NAME_MAX) {
    errors.name = `Name must be at most ${NAME_MAX} characters.`;
  }

  const description = values.description.trim();
  if (description.length === 0) {
    errors.description = "Description is required.";
  } else if (description.length > DESCRIPTION_MAX) {
    errors.description = `Description must be at most ${DESCRIPTION_MAX} characters.`;
  }

  if (!ASSET_TYPES.includes(values.assetType as (typeof ASSET_TYPES)[number])) {
    errors.assetType = "Select an asset type.";
  }

  if (
    !LICENSE_TYPES.includes(values.licenseType as (typeof LICENSE_TYPES)[number])
  ) {
    errors.licenseType = "Select a license type.";
  }

  let priceStroops: bigint | undefined;
  const price = values.priceXlm.trim();
  if (price.length === 0) {
    errors.priceXlm = "Price is required.";
  } else {
    try {
      const stroops = xlmToStroops(price);
      if (stroops <= 0n) {
        errors.priceXlm = "Price must be greater than zero.";
      } else {
        priceStroops = stroops;
      }
    } catch (err) {
      errors.priceXlm =
        err instanceof Error ? err.message : "Enter a valid price.";
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    priceStroops,
  };
}
