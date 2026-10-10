/**
 * The reminder number a lead types at booking → E.164, assuming Mexico.
 *
 * FB/IG leads arrive with no phone, so the bot asks for one right before booking. Asking for
 * "+52" produced friction (a lead who had already picked a slot went silent on that question),
 * and every tenant is Mexican, so a bare 10-digit number is read as Mexican — but only when
 * its first digits are a Mexican area code (LADA). Anything else is NOT guessed: the caller
 * refuses to book and the bot asks the lead which country the number is from. A wrong guess
 * would send the confirmation and reminders to a stranger; a question costs one message.
 *
 * Accepted shapes:
 *   - `+` + 10–15 digits → kept as given (the lead or the model already said the country);
 *   - 10 digits with a known LADA → `+52` + digits;
 *   - `52` + 10 digits with a known LADA → `+` added;
 *   - `521` + 10 digits (the legacy mobile `1` after the country code) → the `1` is dropped.
 */

/** Two-digit LADAs (CDMX, Guadalajara, Monterrey) — matched before the three-digit ones. */
const MX_LADA_2 = new Set(['55', '56', '33', '81']);

/** Three-digit LADAs in the national numbering plan (a gap here costs the lead one question). */
const MX_LADA_3 = new Set(
  (
    '220 221 222 223 224 226 227 228 229 231 232 233 236 237 238 241 243 244 245 246 247 248 249 ' +
    '271 272 273 274 275 276 278 281 282 283 284 287 288 294 296 ' +
    '311 312 313 314 315 316 317 319 321 322 323 324 325 326 327 328 329 341 342 343 344 345 346 347 348 349 ' +
    '351 352 353 354 355 356 357 358 359 371 372 373 374 375 376 377 378 381 382 383 384 385 386 387 388 389 ' +
    '391 392 393 394 395 ' +
    '411 412 413 414 415 417 418 419 421 422 423 424 425 426 427 428 429 431 432 433 434 435 436 437 438 ' +
    '440 441 442 443 444 445 446 447 448 449 451 452 453 454 455 456 457 458 459 461 462 463 464 465 466 468 469 ' +
    '471 472 473 474 475 476 477 479 481 482 483 485 486 487 488 489 492 493 494 495 496 498 499 ' +
    '588 591 592 593 594 595 596 597 599 ' +
    '612 613 614 615 616 618 621 622 624 625 626 627 628 629 631 632 633 634 635 636 637 638 639 ' +
    '641 642 644 645 646 647 648 649 651 652 653 656 657 658 659 661 662 663 664 665 667 668 669 ' +
    '671 672 673 674 675 676 677 686 687 694 695 ' +
    '711 712 713 714 715 716 717 718 719 720 721 722 723 724 725 726 727 728 729 731 732 733 734 735 736 737 738 739 ' +
    '741 742 743 744 745 746 747 748 751 753 754 755 756 757 758 759 761 762 764 767 769 ' +
    '771 772 773 774 775 776 777 778 779 781 782 783 784 785 786 789 791 797 ' +
    '821 823 824 825 826 828 829 831 832 833 834 835 836 841 842 844 861 862 864 866 867 868 869 ' +
    '871 872 873 877 878 891 892 894 897 899 ' +
    '913 914 916 917 918 919 921 922 923 924 932 933 934 936 937 938 951 953 954 958 961 962 963 964 965 966 967 968 ' +
    '971 972 981 982 983 984 985 986 987 988 990 991 992 993 994 995 996 998 999'
  ).split(/\s+/),
);

export function isMexicanAreaCode(national10: string): boolean {
  return MX_LADA_2.has(national10.slice(0, 2)) || MX_LADA_3.has(national10.slice(0, 3));
}

export type PhoneNormalization =
  | { ok: true; e164: string; assumedMexico: boolean }
  | { ok: false; reason: 'too_short' | 'unknown_area_code' | 'not_mexican_shape' };

export function normalizeLeadPhone(raw: string): PhoneNormalization {
  const trimmed = raw.trim();
  const explicit = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (explicit) {
    if (digits.length >= 10 && digits.length <= 15) return { ok: true, e164: `+${digits}`, assumedMexico: false };
    return { ok: false, reason: 'too_short' };
  }
  if (digits.length < 10) return { ok: false, reason: 'too_short' };

  let national: string | null = null;
  if (digits.length === 10) national = digits;
  else if (digits.length === 12 && digits.startsWith('52')) national = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith('521')) national = digits.slice(3);

  if (national === null) return { ok: false, reason: 'not_mexican_shape' };
  if (!isMexicanAreaCode(national)) return { ok: false, reason: 'unknown_area_code' };
  return { ok: true, e164: `+52${national}`, assumedMexico: digits.length === 10 };
}

/** One line for the model, per refusal reason — it asks the lead, it never guesses. */
export function phoneRefusalNote(reason: Exclude<PhoneNormalization, { ok: true }>['reason']): string {
  const why =
    reason === 'too_short'
      ? 'le faltan dígitos (un número de México tiene 10)'
      : reason === 'unknown_area_code'
        ? 'sus primeros dígitos no corresponden a una lada de México'
        : 'no tiene la forma de un número de México a 10 dígitos';
  return (
    `No agendé todavía: el número que me pasaste ${why}. ` +
    'Pregúntale al lead, en una línea y con calidez, si su número es de México: si lo es, pídele los 10 dígitos; ' +
    'si es de otro país, pídeselo con su código de país (+1, +34…). ' +
    'Cuando lo tengas, vuelve a llamar bookAppointment con el mismo horario y ese número.'
  );
}
