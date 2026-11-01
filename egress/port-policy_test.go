package smokescreen
import (
 "net/http"
 "testing"
 "github.com/stripe/smokescreen/pkg/smokescreen/hostport"
)
func TestOpenDuetPorts(t *testing.T) {
 req, _ := http.NewRequest("GET", "http://example.com", nil)
 for _, port := range []int{0, 22, 25, 53, 80, 443, 465, 8080, 65535} {
  denied := openDuetPortPolicy(req, hostport.HostPort{Host:"example.com", Port:port})
  if (denied == nil) != (port == 80 || port == 443) { t.Fatalf("incorrect policy for %d", port) }
 }
 req.Header.Set("X-Upstream-Https-Proxy", "proxy.example.com:25")
 if openDuetPortPolicy(req, hostport.HostPort{Host:"example.com", Port:443}) == nil { t.Fatal("upstream proxy bypass") }
}
