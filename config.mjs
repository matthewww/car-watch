/** Search definitions — add one object to watch another model.
 * filters: AutoTrader query params ("" = none, landscape watch)
 * priceCap: drop listings above it (null = no cap, for landscape searches)
 * pageCap: max province pages scanned per run */
export const SEARCHES = [
  {
    key: "duster",
    make: "renault",
    model: "duster",
    label: "Renault Duster",
    filters: "price=less-than-300000&year=more-than-2019&mileage=less-than-100000",
    priceCap: 300000,
    pageCap: 8,
  },
  {
    key: "caddy",
    make: "volkswagen",
    model: "caddy",
    label: "VW Caddy",
    filters: "price=less-than-300000&mileage=less-than-100000",
    priceCap: 300000,
    pageCap: 14,
  },
  {
    key: "jimny",
    make: "suzuki",
    model: "jimny",
    label: "Suzuki Jimny",
    filters: "price=less-than-300000&mileage=less-than-100000", // no year cap; 5-door models get called out
    priceCap: 300000,
    pageCap: 14,
  },
  {
    key: "seltos",
    make: "kia",
    model: "seltos",
    label: "Kia Seltos",
    filters: "price=less-than-300000&year=more-than-2019&mileage=less-than-100000",
    priceCap: 300000,
    pageCap: 8,
  },
  {
    key: "creta",
    make: "hyundai",
    model: "creta",
    label: "Hyundai Creta",
    filters: "price=less-than-300000&year=more-than-2019&mileage=less-than-100000",
    priceCap: 300000,
    pageCap: 8,
  },
  {
    key: "hr-v",
    make: "honda",
    model: "hr-v",
    label: "Honda HR-V",
    filters: "price=less-than-300000&year=more-than-2019&mileage=less-than-100000",
    priceCap: 300000,
    pageCap: 8,
  },
  {
    key: "corolla-cross",
    make: "toyota",
    model: "corolla-cross",
    label: "Corolla Cross",
    filters: "price=less-than-300000&year=more-than-2019&mileage=less-than-100000",
    priceCap: 300000,
    pageCap: 8,
  },
];