package cmd

import (
	"github.com/openclaw/gogcli/internal/googleapi"
)

// outboundHTTPClient bounds response-header wait for unauthenticated
// fetches (tracking queries, media downloads, slide thumbnails).
var outboundHTTPClient = googleapi.NewBoundedHTTPClient()
