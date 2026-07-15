/** SQL fragment: resolve change-request text for a CBL row (handles duplicate partner rows). */
export const CHANGE_REQUEST_MESSAGE_SELECT = `
COALESCE(
  ba.change_request_message,
  (
    SELECT ba2.change_request_message
    FROM campaign_business_locations cbl2
    JOIN businesses b2 ON b2.id = cbl2.business_id
    LEFT JOIN business_acceptances ba2 ON ba2.campaign_business_location_id = cbl2.id
    WHERE cbl2.campaign_id = cbl.campaign_id
      AND (
        cbl2.business_id = cbl.business_id
        OR (
          b.contact_email IS NOT NULL
          AND b2.contact_email IS NOT NULL
          AND LOWER(TRIM(b2.contact_email)) = LOWER(TRIM(b.contact_email))
        )
      )
      AND ba2.change_request_message IS NOT NULL
      AND TRIM(ba2.change_request_message) != ''
    ORDER BY ba2.updated_at DESC, cbl2.updated_at DESC
    LIMIT 1
  )
) AS change_request_message`;
