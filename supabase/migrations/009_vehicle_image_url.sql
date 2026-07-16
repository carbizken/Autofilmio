-- Vehicle stock imagery: URL of the studio-style photo (white background,
-- floor shadow) auto-resolved from VIN / year-make-model at RO creation.
-- Populated fire-and-forget by backend/src/lib/vehicleImage.js — null until
-- (and unless) a provider match lands; the frontend keeps its placeholder.

alter table mpi_inspections add column if not exists vehicle_image_url text;
alter table videos add column if not exists vehicle_image_url text;
