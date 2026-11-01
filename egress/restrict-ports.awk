# Build-time patch: fail the build if the pinned upstream hook changes or is duplicated.
{ print }
/^func checkIfRequestShouldBeProxied\(.*destination hostport.HostPort\).*\{$/ {
  print "\tif denied := openDuetPortPolicy(req, destination); denied != nil { return denied, 0, nil }"
  found++
}
END { if (found != 1) exit 1 }
