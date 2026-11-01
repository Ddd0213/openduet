// OpenDuet policy for smokescreen 609eb89; both HTTP and CONNECT use this guard.
package smokescreen

import (
 "net/http"
 "github.com/stripe/smokescreen/pkg/smokescreen/hostport"
)

func openDuetPortPolicy(req *http.Request, destination hostport.HostPort) *ACLDecision {
 if (destination.Port != 80 && destination.Port != 443) || req.Header.Get("X-Upstream-Https-Proxy") != "" {
  return &ACLDecision{OutboundHost: destination.String(), Reason: "OpenDuet permits only direct destination ports 80 and 443", allow: false, enforceWouldDeny: true}
 }
 return nil
}
